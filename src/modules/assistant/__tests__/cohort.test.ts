/**
 * Cohort queries against fixture tenants: every matching patient, never a
 * sample; never another tenant's patients; archived patients, unsigned
 * consultations and stopped medications never count; paging at 200 with the
 * total; precise "nobody" answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createTenant, createUser, dbTestsEnabled, deleteTenants } from "@/test/db";
import { COHORT_PAGE_SIZE, parseCohortQuestion, runCohortQuery, summarizeCohort } from "@/modules/assistant/cohort";
import { buildEvalClinic, FIXTURE_TIMEZONE, type FixtureClinic } from "@/modules/assistant/eval/fixture";

describe.skipIf(!dbTestsEnabled)("cohort queries", () => {
  let f: FixtureClinic;
  let bigTenant: string;

  beforeAll(async () => {
    f = await buildEvalClinic((o) => createUser(o));
    // A tenant with more matching patients than one page holds.
    bigTenant = (await createTenant({ slug: `cohort-big-${Date.now().toString(36)}` })).id;
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `big-${bigTenant.slice(-6)}-${String(i).padStart(3, "0")}`, tenantId: bigTenant, fullName: `Latex Patient ${String(i).padStart(3, "0")}`, gender: "FEMALE" as const }));
    await db.patient.createMany({ data: rows });
    await db.medicalHistory.createMany({ data: rows.map((r) => ({ tenantId: bigTenant, patientId: r.id, allergies: ["Latex"] })) });
  }, 60_000);

  afterAll(async () => {
    await deleteTenants([f.tenantId, f.otherTenantId, bigTenant].filter(Boolean));
  });

  async function ask(question: string, tenantId = f.tenantId, page = 1) {
    const parsed = parseCohortQuestion(question, { now: f.now, timeZone: FIXTURE_TIMEZONE, doctors: [{ id: f.doctors.omar, name: "Dr. Omar Fahmy" }, { id: f.doctors.mariam, name: "Dr. Mariam Tarek" }], tags: ["vip", "new-patient"] });
    const result = await runCohortQuery(tenantId, parsed.criteria, { timeZone: FIXTURE_TIMEZONE, now: f.now, page, details: parsed.details });
    return { parsed, result, summary: summarizeCohort(parsed, parsed.criteria, result) };
  }
  const k = (...keys: string[]) => keys.map((key) => f.ids[key]!).sort();

  it("finds all 11 of 11 patients with a penicillin-class allergy, however it is written", async () => {
    const { result, summary } = await ask("Which patients have a documented allergy to penicillin?");
    expect(result.total).toBe(11);
    expect([...result.ids].sort()).toEqual(k("amira", "bassem", "camilia", "doaa", "essam", "fady", "ghada", "hesham", "inas", "kamal", "lamia"));
    expect(summary.headline).toBe("11 patients have penicillin recorded as an allergy (all 11 shown).");
    // The fact that matched, as recorded, and where.
    const fady = result.rows.find((r) => r.patientId === f.ids.fady)!;
    expect(fady.facts[0]).toMatchObject({ label: "Allergy", value: "Penicilin", where: "Medical history · Allergies", source: "DIAGNOSIS" });
    const ghada = result.rows.find((r) => r.patientId === f.ids.ghada)!;
    expect(ghada.facts[0]).toMatchObject({ value: "Amoxicillin", note: "penicillin class" });
    expect(result.rows.find((r) => r.patientId === f.ids.hesham)!.facts[0]!.value).toBe("بنسلين");
  });

  it("never lists an archived patient", async () => {
    const { result } = await ask("Which patients have a documented allergy to penicillin?");
    expect(result.ids).not.toContain(f.ids.nabila);
  });

  it("answers 'lidocaine or penicillin' with the union, sorted by name, and counts per term", async () => {
    const { result, summary } = await ask("Which patients have a documented allergy to lidocaine or penicillin?");
    expect(result.total).toBe(12);
    expect(result.rows.map((r) => r.name)).toEqual([...result.rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
    expect(result.termCounts).toEqual([
      { criterion: 0, term: "lidocaine", count: 2 },
      { criterion: 0, term: "penicillin", count: 11 },
    ]);
    expect(summary.lines).toContain("By term: lidocaine 2 · penicillin 11.");
  });

  it("says precisely which term found nobody", async () => {
    const { result, summary } = await ask("Which patients are allergic to chlorhexidine or latex?");
    expect(result.ids).toEqual([f.ids.doaa]);
    expect(summary.lines).toContain("No patient has chlorhexidine recorded as an allergy.");
  });

  it("answers 'nobody' precisely instead of 'no matching records'", async () => {
    const warfarin = await ask("Which patients are on warfarin?");
    expect(warfarin.result.total).toBe(0);
    expect(warfarin.summary.headline).toBe("No patient has warfarin recorded as an active medication.");
    const chlorhexidine = await ask("Which patients have a documented allergy to chlorhexidine?");
    expect(chlorhexidine.summary.headline).toBe("No patient has chlorhexidine recorded as an allergy.");
  });

  it("excludes women from 'male patients with PCOS' and flags the implausible entry", async () => {
    const { result, summary } = await ask("Which male patients have PCOS?");
    expect(result.ids).toEqual([f.ids.wael]);
    expect(summary.headline).toBe("1 male patient has PCOS recorded as a condition or diagnosis (shown below).");
    expect(summary.lines.join(" ")).toMatch(/PCOS is recorded for 1 male patient/);
    const women = await ask("Which female patients have PCOS?");
    expect([...women.result.ids].sort()).toEqual(k("rania", "salma", "tamara", "yara"));
  });

  it("counts a diagnosis from a signed consultation, never from an unsigned draft", async () => {
    const { result } = await ask("How many patients have rosacea?");
    expect([...result.ids].sort()).toEqual(k("omar", "nermine"));
    const nermine = result.rows.find((r) => r.patientId === f.ids.nermine)!;
    expect(nermine.facts[0]).toMatchObject({ value: "Papulopustular rosacea", source: "TRANSCRIPT" });
    expect(nermine.facts[0]!.where).toMatch(/^Signed consultation · \d{4}-\d{2}-\d{2}$/);
    expect(result.ids).not.toContain(f.ids.zeinab);
  });

  it("matches brand and generic names on active medications only, with the dose", async () => {
    const generic = await ask("Who is currently on isotretinoin, and at what dose?");
    expect([...generic.result.ids].sort()).toEqual(k("hana", "islam", "jana"));
    expect(generic.result.ids).not.toContain(f.ids.khaled); // stopped
    const islam = generic.result.rows.find((r) => r.patientId === f.ids.islam)!;
    expect(islam.facts[0]!.value).toBe("Roaccutane 10mg Once daily");
    const brand = await ask("Which patients take Roaccutane?");
    expect([...brand.result.ids].sort()).toEqual([...generic.result.ids].sort());
  });

  it("filters by the strength asked for", async () => {
    const { result } = await ask("Who takes finasteride 1 mg?");
    expect([...result.ids].sort()).toEqual(k("bassem", "mahmoud"));
  });

  it("combines age, sex and allergy, with ages in completed years on the clinic calendar", async () => {
    const { result } = await ask("ستات فوق ٤٠ عندهم حساسية من البنسلين");
    expect([...result.ids].sort()).toEqual(k("camilia", "inas", "lamia"));
    const over40 = await ask("Which female patients are over 40?");
    expect(over40.result.ids).not.toContain(f.ids.mona); // 40 today, 41 tomorrow
    expect(over40.result.ids).not.toContain(f.ids.noDob);
    expect(over40.result.notes.join(" ")).toMatch(/no date of birth recorded/);
  });

  it("supports negation against the whole tenant", async () => {
    const { result } = await ask("Which patients are not on finasteride?");
    const all = await db.patient.count({ where: { tenantId: f.tenantId, deletedAt: null } });
    expect(result.total).toBe(all - 3);
    expect(result.ids).not.toContain(f.ids.bassem);
    expect(result.rows[0]!.facts[0]).toMatchObject({ value: "not recorded" });
  });

  it("answers doctor, tag, appointment and last-visit questions", async () => {
    expect([...(await ask("Which patients of Dr. Mariam Tarek have acne?")).result.ids].sort()).toEqual(k("hana", "jana"));
    expect([...(await ask("Which VIP patients have melasma?")).result.ids].sort()).toEqual(k("camilia", "tarek"));
    const upcoming = await ask("Which patients have an upcoming appointment?");
    expect([...upcoming.result.ids].sort()).toEqual(k("jana", "rania", "tarek"));
    expect(upcoming.result.ids).not.toContain(f.ids.omar); // cancelled
    const lapsed = await ask("Which patients haven't been seen in 6 months?");
    expect(lapsed.result.ids).toEqual(expect.arrayContaining(k("bassem", "essam")));
    expect(lapsed.result.ids).not.toContain(f.ids.hana);
    const transplant = await ask("Which patients had an FUE hair transplant, and how many grafts?");
    expect([...transplant.result.ids].sort()).toEqual(k("hassan", "sherif"));
    expect(transplant.result.ids).not.toContain(f.ids.youssef); // only planned
    expect(transplant.result.rows.find((r) => r.patientId === f.ids.hassan)!.facts[0]!.value).toBe("FUE hair transplant (2,400 grafts)");
  });

  it("never returns another tenant's patients, even when restricted to their ids", async () => {
    const a = await ask("Which patients have a documented allergy to lidocaine or penicillin?");
    const b = await ask("Which patients have a documented allergy to lidocaine or penicillin?", f.otherTenantId);
    expect(b.result.total).toBe(2);
    expect(a.result.ids.filter((id) => f.otherIds.includes(id))).toEqual([]);
    expect(b.result.ids.every((id) => f.otherIds.includes(id))).toBe(true);
    const parsed = parseCohortQuestion("Which patients are allergic to penicillin?");
    const leak = await runCohortQuery(f.tenantId, parsed.criteria, { timeZone: FIXTURE_TIMEZONE, restrictTo: f.otherIds });
    expect(leak.total).toBe(0);
    const pcos = await ask("Which male patients have PCOS?");
    expect(pcos.result.ids).toEqual([f.ids.wael]);
  });

  it("pages at 200 and reports the total", async () => {
    const first = await ask("Which patients are allergic to latex?", bigTenant, 1);
    expect(COHORT_PAGE_SIZE).toBe(200);
    expect(first.result).toMatchObject({ total: 205, page: 1, pageSize: 200, pages: 2 });
    expect(first.result.rows).toHaveLength(200);
    expect(first.summary.headline).toBe("205 patients have latex recorded as an allergy (showing 1–200 of 205).");
    const second = await ask("Which patients are allergic to latex?", bigTenant, 2);
    expect(second.result.rows).toHaveLength(5);
    const all = new Set([...first.result.rows, ...second.result.rows].map((r) => r.patientId));
    expect(all.size).toBe(205);
    expect(first.result.ids).toHaveLength(205);
  });
});
