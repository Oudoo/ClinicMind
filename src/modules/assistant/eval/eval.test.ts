/**
 * The assistant's evaluation set (audit #16) on every commit: a fixture clinic
 * with known answers, every question asked through the real service (parser,
 * cohort queries, name resolution and retrieval with the offline provider),
 * and each answer must contain exactly the right patients.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reindexTenant } from "@/modules/knowledge/ingest";
import { createUser, dbTestsEnabled, deleteTenants, runAsSystem } from "@/test/db";
import { buildEvalClinic, type FixtureClinic } from "./fixture";
import { EVAL_CASES, loadSnapshot } from "./questions";
import { formatEvalTable, runEvalSet, type EvalOutcome } from "./run";

// These tests call the services directly, outside any route.
runAsSystem();

describe.skipIf(!dbTestsEnabled)("assistant evaluation set", () => {
  let f: FixtureClinic;
  let outcomes: EvalOutcome[] = [];

  beforeAll(async () => {
    f = await buildEvalClinic((o) => createUser(o));
    // The open questions are answered by retrieval: index the fixture clinic.
    await reindexTenant(f.tenantId);
    outcomes = await runEvalSet({ tenantId: f.tenantId, userId: f.ownerId, email: null }, { now: f.now });
  }, 180_000);

  afterAll(async () => {
    if (f) await deleteTenants([f.tenantId, f.otherTenantId]);
  });

  const k = (...keys: string[]) => keys.map((key) => f.ids[key]!).sort();

  it("has at least 25 questions, including Arabic, named-patient, nothing-matching and open ones", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(25);
    const cats = EVAL_CASES.map((c) => c.category).join(" | ");
    for (const needle of ["allergy (or)", "Arabic", "named patient", "nothing matches", "open question", "sex + age", "medication (brand)", "medication (generic)"]) {
      expect(cats).toContain(needle);
    }
    expect(EVAL_CASES.filter((c) => c.category.startsWith("open question"))).toHaveLength(2);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
  });

  it("the oracles agree with the fixture's known answers", async () => {
    const s = await loadSnapshot(f.tenantId, f.now);
    const expectIds = (id: string) => [...(EVAL_CASES.find((c) => c.id === id)!.expect(s).ids ?? [])].sort();
    const penicillin = k("amira", "bassem", "camilia", "doaa", "essam", "fady", "ghada", "hesham", "inas", "kamal", "lamia");
    expect(expectIds("allergy-penicillin")).toEqual(penicillin);
    expect(expectIds("allergy-or")).toEqual([...penicillin, f.ids.magdy!].sort());
    expect(expectIds("allergy-lidocaine")).toEqual(k("inas", "magdy"));
    expect(expectIds("pcos-male")).toEqual(k("wael"));
    expect(expectIds("pcos-female")).toEqual(k("rania", "salma", "tamara", "yara"));
    expect(expectIds("rosacea-count")).toEqual(k("omar", "nermine"));
    expect(expectIds("isotretinoin-generic")).toEqual(k("hana", "islam", "jana"));
    expect(expectIds("finasteride-strength")).toEqual(k("bassem", "mahmoud"));
    expect(expectIds("cephalexin")).toEqual(k("hassan", "nader"));
    expect(expectIds("finasteride-over-50")).toEqual(k("bassem", "essam"));
    expect(expectIds("arabic-sex-age-allergy")).toEqual(k("camilia", "inas", "lamia"));
    expect(expectIds("vip-melasma")).toEqual(k("camilia", "tarek"));
    expect(expectIds("doctor-acne")).toEqual(k("hana", "jana"));
    expect(expectIds("hair-transplant")).toEqual(k("hassan", "sherif"));
    expect(expectIds("upcoming")).toEqual(k("jana", "tarek", "rania"));
    expect(expectIds("women-over-40")).not.toContain(f.ids.mona); // 40, turns 41 tomorrow
    expect(expectIds("warfarin-nothing")).toEqual([]);
  });

  it("answers every question with exactly the right patients (precision and recall 100%)", () => {
    const failures = outcomes.filter((o) => !o.pass);
    if (failures.length) console.log(formatEvalTable(outcomes));
    expect(failures.map((o) => `${o.id}: ${o.problems.join("; ")}`)).toEqual([]);
    for (const o of outcomes) {
      expect(o.precision, o.id).toBe(1);
      expect(o.recall, o.id).toBe(1);
    }
  });

  it("lists all eleven penicillin allergies, however they are written", () => {
    const o = outcomes.find((x) => x.id === "allergy-penicillin")!;
    expect(o.mode).toBe("cohort");
    expect([...o.got].sort()).toEqual(k("amira", "bassem", "camilia", "doaa", "essam", "fady", "ghada", "hesham", "inas", "kamal", "lamia"));
    expect(o.got).not.toContain(f.ids.nabila); // archived
  });

  it("keeps the open questions on retrieval", () => {
    for (const id of ["open-today", "open-melasma"]) {
      const o = outcomes.find((x) => x.id === id)!;
      expect(o.mode, id).toBe("rag");
      expect(o.got.length, id).toBeGreaterThan(0);
    }
  });

  it("never answers with another clinic's patients", () => {
    const foreign = new Set(f.otherIds);
    for (const o of outcomes) expect(o.got.filter((id) => foreign.has(id)), o.id).toEqual([]);
  });
});
