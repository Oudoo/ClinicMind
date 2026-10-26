import { describe, expect, it } from "vitest";
import { answersSchema, summarizeCheckIn } from "@/modules/concierge/answers";
import { DEFAULT_PROTOCOLS, buildStepMessage, dayLabel, parseSteps, stepHasHighRisk, zSteps, type ProtocolStep } from "@/modules/concierge/protocols";
import { scanFreeText, triageAnswers } from "@/modules/concierge/triage";

/**
 * Triage is pure: answers against a step's questions. These tests pin the
 * ranges, the high-risk rules, the free-text red flags (English and Arabic)
 * and the protocol definitions they run on.
 */
const hair = DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === "hair-transplant")!;
const day1 = hair.steps[1]!; // pain, swelling, bleeding, fever
const laser = DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === "laser-hair-removal")!;

describe("triage: ranges", () => {
  it("is OK when every answer is inside its expected range", () => {
    const r = triageAnswers(day1, { pain: 2, swelling: true, bleeding: false, fever: false });
    expect(r).toEqual({ level: "OK", flags: [] });
  });

  it("flags a scale above the expected maximum as WATCH", () => {
    const r = triageAnswers(day1, { pain: 6, swelling: false, bleeding: false, fever: false });
    expect(r.level).toBe("WATCH");
    expect(r.flags).toEqual([{ key: "pain", label: expect.stringContaining("Pain"), value: 6, expected: "≤ 4", highRisk: false }]);
  });

  it("treats the danger range of a graded scale as HIGH_RISK on its own", () => {
    expect(triageAnswers(day1, { pain: 8, bleeding: false, fever: false }).level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, { pain: 7, bleeding: false, fever: false }).level).toBe("WATCH");
    expect(triageAnswers(day1, { pain: 4, bleeding: false, fever: false }).level).toBe("OK");
  });

  it("flags a scale below an expected minimum", () => {
    const month12 = hair.steps[hair.steps.length - 1]!;
    const r = triageAnswers(month12, { density: 3 });
    expect(r.level).toBe("WATCH");
    expect(r.flags[0]).toMatchObject({ key: "density", expected: "≥ 6" });
  });

  it("does not flag a yes/no question without an expectation (swelling either way)", () => {
    expect(triageAnswers(day1, { swelling: true }).level).toBe("OK");
    expect(triageAnswers(day1, { swelling: false }).level).toBe("OK");
  });

  it("flags an unexpected yes/no answer as WATCH when the question is not high-risk", () => {
    const day2 = laser.steps[1]!; // swelling expected no, not high-risk
    const r = triageAnswers(day2, { redness: 1, burning: 0, blistering: false, swelling: true });
    expect(r.level).toBe("WATCH");
    expect(r.flags).toEqual([{ key: "swelling", label: "Any swelling?", value: true, expected: "no", highRisk: false }]);
  });

  it("ignores missing answers and unknown keys", () => {
    expect(triageAnswers(day1, { unknown: 99 })).toEqual({ level: "OK", flags: [] });
    expect(triageAnswers(day1, { pain: null, bleeding: undefined })).toEqual({ level: "OK", flags: [] });
  });

  it("accepts string forms of numbers and booleans", () => {
    expect(triageAnswers(day1, { pain: "9" }).level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, { bleeding: "yes" }).level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, { bleeding: "no" }).level).toBe("OK");
  });
});

describe("triage: high-risk questions", () => {
  it("escalates bleeding and fever to HIGH_RISK", () => {
    const r = triageAnswers(day1, { pain: 1, swelling: false, bleeding: true, fever: false });
    expect(r.level).toBe("HIGH_RISK");
    expect(r.flags).toEqual([{ key: "bleeding", label: expect.stringContaining("bleeding"), value: true, expected: "no", highRisk: true }]);
    expect(triageAnswers(day1, { fever: true }).level).toBe("HIGH_RISK");
  });

  it("keeps the highest level when several questions are out of range", () => {
    const r = triageAnswers(day1, { pain: 6, bleeding: true, fever: false });
    expect(r.level).toBe("HIGH_RISK");
    expect(r.flags.map((f) => f.key).sort()).toEqual(["bleeding", "pain"]);
  });

  it("knows which steps carry a high-risk question", () => {
    expect(stepHasHighRisk(day1)).toBe(true);
    const photos = hair.steps.find((s) => s.kind === "PHOTO_REQUEST")!;
    expect(stepHasHighRisk(photos)).toBe(false);
  });
});

describe("triage: free text", () => {
  it("raises at least WATCH for red-flag words in English", () => {
    for (const t of ["There is some bleeding at the back", "I have a fever since last night", "yellow pus from one graft", "the pain is severe"]) {
      const r = triageAnswers(day1, { pain: 1, bleeding: false, fever: false }, t);
      expect(r.level, t).toBe("WATCH");
      expect(r.flags[0]).toMatchObject({ key: "freeText", highRisk: false, expected: null });
    }
  });

  it("raises HIGH_RISK when the patient cannot breathe", () => {
    expect(triageAnswers(day1, {}, "I can't breathe properly").level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, {}, "cannot breathe").level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, {}, "مش قادر أتنفس كويس").level).toBe("HIGH_RISK");
    expect(triageAnswers(day1, {}, "عندي صعوبة في التنفس").level).toBe("HIGH_RISK");
  });

  it("understands the Arabic red-flag words", () => {
    expect(scanFreeText("في نزيف خفيف من ورا").map((f) => f.value)).toEqual(["نزيف"]);
    expect(triageAnswers(day1, {}, "عندي حرارة من امبارح").level).toBe("WATCH");
    expect(triageAnswers(day1, {}, "حاسس بسخونية").level).toBe("WATCH");
    expect(triageAnswers(day1, {}, "في صديد في مكان الزراعة").level).toBe("WATCH");
    expect(triageAnswers(day1, {}, "الألم شديد").level).toBe("WATCH");
    expect(triageAnswers(day1, {}, "الحمد لله كله تمام").level).toBe("OK");
  });

  it("scans text answers the same way", () => {
    const general = DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === "general-dermatology")!.steps[1]!;
    const r = triageAnswers(general, { improving: true, fever: false, sideEffects: "a bit of bleeding where I scratched" });
    expect(r.level).toBe("WATCH");
    expect(r.flags[0]).toMatchObject({ key: "sideEffects" });
  });
});

describe("answers schema and summaries", () => {
  it("requires every structured answer and coerces strings", () => {
    const schema = answersSchema(day1);
    const parsed = schema.parse({ pain: "3", swelling: "yes", bleeding: false, fever: "no", extra: 1 });
    expect(parsed).toEqual({ pain: 3, swelling: true, bleeding: false, fever: false });
    const missing = schema.safeParse({ pain: 3 });
    expect(missing.success).toBe(false);
    const outOfRange = schema.safeParse({ pain: 11, swelling: true, bleeding: false, fever: false });
    expect(outOfRange.success).toBe(false);
  });

  it("writes a one-line summary for the timeline", () => {
    const line = summarizeCheckIn(day1, { answers: { pain: 3, swelling: true, bleeding: false, fever: false }, satisfaction: null, triage: "OK" });
    expect(line).toBe("Day 1 check-in: pain 3/10, swelling yes, bleeding no, fever no · OK");
  });
});

describe("protocol definitions", () => {
  it("every default protocol validates and covers the spec's days", () => {
    for (const p of DEFAULT_PROTOCOLS) {
      expect(zSteps.safeParse(p.steps).success, p.treatmentKey).toBe(true);
      expect(parseSteps(p.steps)).toHaveLength(p.steps.length);
    }
    const days = (key: string) => DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === key)!.steps.map((s) => Math.round(s.offsetHours / 24));
    expect(days("hair-transplant")).toEqual([0, 1, 3, 7, 7, 14, 30, 90, 180, 365]);
    expect(days("prp-hair")).toEqual([0, 2, 7, 14]);
    expect(days("laser-hair-removal")).toEqual([0, 2, 7, 14]);
    expect(days("botox-fillers")).toEqual([0, 1, 7, 14]);
    expect(days("general-dermatology")).toEqual([0, 7, 14]);
    const last = (key: string) => DEFAULT_PROTOCOLS.find((p) => p.treatmentKey === key)!.steps.at(-1)!;
    for (const key of ["prp-hair", "laser-hair-removal", "acne", "pigmentation", "botox-fillers", "general-dermatology"]) {
      expect(last(key).satisfaction, key).toBe(true);
    }
  });

  it("rejects malformed steps and duplicate question keys", () => {
    const bad: unknown = [{ offsetHours: -1, kind: "CHECK_IN", title: "x", body: { ar: "", en: "" } }];
    expect(zSteps.safeParse(bad).success).toBe(false);
    const dup: ProtocolStep = { ...day1, questions: [day1.questions![0]!, day1.questions![0]!] };
    expect(zSteps.safeParse([dup]).success).toBe(false);
    expect(parseSteps("nonsense")).toEqual([]);
  });

  it("builds a warm bilingual message with the clinic phone and the link", () => {
    const ctx = { clinicName: "Aura Clinic", clinicPhone: "+20 2 2735 0101", patientFirstName: "Omar", link: "https://clinic.example/check-in/abc" };
    const en = buildStepMessage(day1, { ...ctx, language: "en" });
    expect(en).toContain("Hi Omar,");
    expect(en).toContain("https://clinic.example/check-in/abc");
    expect(en).toContain("— Aura Clinic");
    const instruction = buildStepMessage(hair.steps[0]!, { ...ctx, language: "ar", link: null });
    expect(instruction).toContain("أهلاً Omar");
    expect(instruction).toContain("+20 2 2735 0101");
    expect(instruction).not.toContain("{{phone}}");
    const reminder = buildStepMessage(day1, { ...ctx, language: "ar", reminder: true });
    expect(reminder).toContain("تذكير");
    expect(reminder).toContain(ctx.link);
    expect(dayLabel(day1, "ar")).toBe("اليوم ١");
    expect(dayLabel({ offsetHours: 24 * 90 })).toBe("Month 3");
  });
});
