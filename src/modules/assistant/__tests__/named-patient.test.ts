/**
 * Questions about one named patient (audit #18: "Is Tarek Ezzat on
 * Cephalexin?" used to return three other patients): the name is resolved
 * first (exact, then fuzzy; ambiguous names are asked about), and the answer
 * cites that patient only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reindexTenant } from "@/modules/knowledge/ingest";
import { createUser, dbTestsEnabled, deleteTenants, runAsSystem } from "@/test/db";
import { askAssistant, type AssistantActor } from "@/modules/assistant/service";
import { resolvePatientMention } from "@/modules/assistant/patients";
import { parseCohortQuestion } from "@/modules/assistant/parser";
import { buildEvalClinic, type FixtureClinic } from "@/modules/assistant/eval/fixture";

// These tests call the services directly, outside any route.
runAsSystem();

describe.skipIf(!dbTestsEnabled)("named-patient questions", () => {
  let f: FixtureClinic;
  let actor: AssistantActor;

  beforeAll(async () => {
    f = await buildEvalClinic((o) => createUser(o));
    await reindexTenant(f.tenantId);
    await reindexTenant(f.otherTenantId);
    actor = { tenantId: f.tenantId, userId: f.ownerId, email: null };
  }, 120_000);

  afterAll(async () => {
    await deleteTenants([f.tenantId, f.otherTenantId]);
  });

  const ask = (query: string, patientId?: string) => askAssistant(actor, { query, patientId }, { record: false, now: f.now });
  const resolve = (q: string, tenantId = f.tenantId) => {
    const p = parseCohortQuestion(q);
    return resolvePatientMention(tenantId, p.leftover, p.subject);
  };

  describe("name resolution", () => {
    it("resolves an exact full name, then a misspelt one", async () => {
      expect(await resolve("Is Tarek Ezzat on Cephalexin?")).toMatchObject({ status: "resolved", how: "exact", patient: { id: f.ids.tarek } });
      expect(await resolve("Is tarek ezzat on cephalexin?")).toMatchObject({ status: "resolved", patient: { id: f.ids.tarek } });
      expect(await resolve("Is Tarik Ezat on Cephalexin?")).toMatchObject({ status: "resolved", how: "fuzzy", patient: { id: f.ids.tarek } });
    });

    it("resolves a name written in Arabic script", async () => {
      expect(await resolve("هل طارق عزت بياخد سيفالكسين؟")).toMatchObject({ status: "resolved", patient: { id: f.ids.tarek } });
    });

    it("accepts a first name alone only when one patient has it, and asks otherwise", async () => {
      expect(await resolve("Is Nader on Keflex?")).toMatchObject({ status: "resolved", how: "partial", patient: { id: f.ids.nader } });
      const ahmed = await resolve("Is Ahmed on finasteride?");
      expect(ahmed.status).toBe("ambiguous");
      if (ahmed.status === "ambiguous") expect(ahmed.candidates.map((c) => c.fullName).sort()).toEqual(["Ahmed Kamel", "Ahmed Saleh"]);
      const ezzat = await resolve("Is Ezzat on cephalexin?");
      expect(ezzat.status).toBe("ambiguous");
    });

    it("says when nobody has the name", async () => {
      expect(await resolve("Is Zoltan Quimby on Cephalexin?")).toMatchObject({ status: "not_found" });
    });

    it("only ever resolves patients of the asking clinic", async () => {
      const a = await resolve("Is Tarek Ezzat on Cephalexin?");
      const b = await resolve("Is Tarek Ezzat on Cephalexin?", f.otherTenantId);
      expect(a.status === "resolved" && b.status === "resolved").toBe(true);
      if (a.status === "resolved" && b.status === "resolved") {
        expect(a.patient.id).toBe(f.ids.tarek);
        expect(f.otherIds).toContain(b.patient.id);
      }
    });
  });

  describe("answers", () => {
    it("answers 'Is Tarek Ezzat on Cephalexin?' from his chart only: no, and what he is on", async () => {
      const a = await ask("Is Tarek Ezzat on Cephalexin?");
      expect(a.mode).toBe("patient");
      expect(a.citations).toHaveLength(1);
      expect(a.citations[0]).toMatchObject({ patientId: f.ids.tarek, patientName: "Tarek Ezzat", href: `/dashboard/patients/${f.ids.tarek}` });
      expect(a.cohort!.headline).toBe("No — Tarek Ezzat has no active cephalexin on record.");
      expect(a.cohort!.rows[0]!.facts[0]).toMatchObject({ label: "Active medications", unmet: true });
      expect(a.cohort!.rows[0]!.facts[0]!.value).toContain("Tranexamic acid 250 mg Twice daily");
      // Hassan Ezzat and Nader Kamal ARE on cephalexin: they must not appear.
      expect(a.answer).not.toMatch(/Hassan|Nader/);
    });

    it("answers yes for a brand name, with the medication as recorded", async () => {
      const a = await ask("Is Hassan Ezzat on Keflex?");
      expect(a.mode).toBe("patient");
      expect(a.cohort!.headline).toBe("Yes — Hassan Ezzat has cephalexin as an active medication: Cephalexin 500 mg Twice daily for 5 days.");
      expect(a.citations.map((c) => c.patientId)).toEqual([f.ids.hassan]);
    });

    it("answers an Arabic question about a patient whose record is in Latin script", async () => {
      const a = await ask("هل طارق عزت بياخد سيفالكسين؟");
      expect(a.mode).toBe("patient");
      expect(a.citations.map((c) => c.patientId)).toEqual([f.ids.tarek]);
      expect(a.cohort!.headline.startsWith("لا —")).toBe(true);
    });

    it("lists a named patient's allergies", async () => {
      const a = await ask("What are Inas Farouk's allergies?");
      expect(a.mode).toBe("patient");
      expect(a.cohort!.headline).toBe("Inas Farouk's recorded allergies: Penicillin; Lidocaine.");
    });

    it("restricts retrieval to the named patient for open questions", async () => {
      const a = await ask("Summarise Tarek Ezzat's melasma history");
      expect(a.mode).toBe("rag");
      expect(a.citations.length).toBeGreaterThan(0);
      expect(a.citations.every((c) => c.patientId === f.ids.tarek)).toBe(true);
      expect(a.scope).toEqual({ label: "Tarek Ezzat", patients: 1 });
    });

    it("asks which patient when a first name is shared, and lists them as choices", async () => {
      const a = await ask("Is Ahmed on finasteride?");
      expect(a.mode).toBe("clarify");
      expect(a.citations).toEqual([]);
      expect(a.clarify!.reason).toBe("ambiguous_patient");
      expect(a.clarify!.options.map((o) => o.patientName).sort()).toEqual(["Ahmed Kamel", "Ahmed Saleh"]);
      expect(a.answer).toBe("Several patients match “Ahmed”: Ahmed Kamel and Ahmed Saleh. Which one do you mean?");
    });

    it("says when the named patient does not exist instead of answering about others", async () => {
      const a = await ask("Is Zoltan Quimby on Cephalexin?");
      expect(a.mode).toBe("clarify");
      expect(a.clarify!.reason).toBe("patient_not_found");
      expect(a.citations).toEqual([]);
    });

    it("refuses to answer about another patient inside a patient-focused chat", async () => {
      const a = await ask("Is Tarek Ezzat on Cephalexin?", f.ids.hassan);
      expect(a.mode).toBe("clarify");
      expect(a.clarify!.reason).toBe("context_mismatch");
      expect(a.clarify!.options[0]).toMatchObject({ patientId: f.ids.tarek });
    });

    it("checks criteria against the focused patient", async () => {
      const a = await ask("Is the patient allergic to penicillin?", f.ids.camilia);
      expect(a.mode).toBe("patient");
      expect(a.cohort!.headline).toBe("Yes — Camilia Fawzy has penicillin recorded as an allergy: Penicillin (rash).");
      const no = await ask("Any allergy to latex?", f.ids.camilia);
      expect(no.cohort!.headline).toBe("No — Camilia Fawzy has no allergy to latex recorded.");
    });
  });
});
