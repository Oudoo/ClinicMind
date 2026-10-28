/**
 * Patient data quality over the real routes and the test database: a new
 * patient whose phone, WhatsApp number (in any spelling: +20, 0, 0020,
 * Arabic-Indic digits) or national id already belongs to an active patient is
 * answered 409 with the matching records unless the caller confirms; dates of
 * birth are bounded (not in the future, at most 120 years ago); a page past
 * the end shows the last page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as list, POST as create } from "@/app/api/patients/route";
import { PATCH as update } from "@/app/api/patients/[id]/route";
import { oldestDateOfBirth } from "@/components/clinicmind/patient-shared";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("the date-of-birth bound (pure)", () => {
  it("offers the form a minimum date 120 years back", () => {
    expect(oldestDateOfBirth(new Date("2026-10-28T12:00:00Z"))).toBe("1906-10-28");
  });
});

describe.skipIf(!dbTestsEnabled)("duplicate patients, dates of birth and paging", () => {
  const created: string[] = [];
  let tenantId: string;
  let owner: string;
  let desk: string;
  let foreignOwner: string;
  let sara: { id: string };
  let omar: { id: string };

  async function post(body: Record<string, unknown>, cookie = desk) {
    const res = await create(request("/api/patients", { body, cookie }));
    return { res, json: await res.json() };
  }

  async function patch(id: string, body: Record<string, unknown>, cookie = desk) {
    const res = await update(request(`/api/patients/${id}`, { method: "PATCH", cookie, body }), params(id));
    return { res, json: await res.json() };
  }

  beforeAll(async () => {
    const a = await createTenant();
    const b = await createTenant();
    created.push(a.id, b.id);
    tenantId = a.id;
    owner = await sessionCookieFor((await createUser({ tenantId, role: "CLINIC_OWNER" })).id);
    desk = await sessionCookieFor((await createUser({ tenantId, role: "RECEPTIONIST" })).id);
    foreignOwner = await sessionCookieFor((await createUser({ tenantId: b.id, role: "CLINIC_OWNER" })).id);
    // Stored the way the seed and the desk store them.
    sara = await db.patient.create({ data: { tenantId, fullName: "Sara Ibrahim", phone: "+201001234567", whatsapp: "+201001234567" }, select: { id: true } });
    omar = await db.patient.create({ data: { tenantId, fullName: "Omar Fathy", phone: "01112223334", nationalId: "29801011234567" }, select: { id: true } });
    await db.patient.create({ data: { tenantId, fullName: "Passport Holder", nationalId: "A12345678" } });
    await db.patient.create({ data: { tenantId, fullName: "Archived Aya", phone: "+201005550000", deletedAt: new Date() } });
    await db.patient.create({ data: { tenantId: b.id, fullName: "Other Clinic Patient", phone: "+201007770000" } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("duplicate phone", () => {
    it.each([
      ["local spelling", "010 0123 4567"],
      ["international", "+20 100 123 4567"],
      ["00 prefix", "00201001234567"],
      ["Arabic-Indic digits", "٠١٠٠١٢٣٤٥٦٧"],
    ])("answers 409 duplicate_phone for the same number (%s) and writes nothing", async (_label, phone) => {
      const before = await db.patient.count({ where: { tenantId } });
      const { res, json } = await post({ fullName: "Sara I.", phone });
      expect(res.status).toBe(409);
      expect(json).toEqual({
        error: "duplicate_phone",
        message: "This number belongs to Sara Ibrahim.",
        matches: [{ id: sara.id, fullName: "Sara Ibrahim", field: "phone" }],
      });
      expect(await db.patient.count({ where: { tenantId } })).toBe(before);
    });

    it("checks the WhatsApp number against both columns", async () => {
      const { res, json } = await post({ fullName: "Omar's Brother", whatsapp: "+201112223334" });
      expect(res.status).toBe(409);
      expect(json.matches).toEqual([{ id: omar.id, fullName: "Omar Fathy", field: "whatsapp" }]);
    });

    it("saves anyway when confirmed, and the audit names the record it duplicates", async () => {
      const { res, json } = await post({ fullName: "Sara's Daughter", phone: "01001234567", confirmDuplicate: true });
      expect(res.status).toBe(201);
      expect(json.patient).toMatchObject({ fullName: "Sara's Daughter", phone: "01001234567" });
      expect(json.patient).not.toHaveProperty("confirmDuplicate");
      const log = await db.auditLog.findFirst({ where: { tenantId, action: "patient.create", entityId: json.patient.id } });
      expect(log?.after).toMatchObject({ confirmedDuplicateOf: [sara.id] });
    });

    it("ignores archived patients and other clinics' patients", async () => {
      expect((await post({ fullName: "New Aya", phone: "01005550000" })).res.status).toBe(201);
      const other = await post({ fullName: "Not A Duplicate", phone: "+201007770000" });
      expect(other.res.status).toBe(201);
      expect(JSON.stringify(other.json)).not.toContain("Other Clinic Patient");
    });

    it("validates the confirmation flag", async () => {
      const { res, json } = await post({ fullName: "Flag", phone: "+201009998877", confirmDuplicate: "yes" });
      expect(res.status).toBe(422);
      expect(json.issues.fieldErrors.confirmDuplicate).toBeDefined();
    });
  });

  describe("duplicate national id", () => {
    it("answers 409 duplicate_national_id (Arabic digits, passports in any case) and names the phone match too", async () => {
      const arabic = await post({ fullName: "Omar F.", nationalId: "٢٩٨٠١٠١١٢٣٤٥٦٧" });
      expect(arabic.res.status).toBe(409);
      expect(arabic.json).toMatchObject({ error: "duplicate_national_id", message: "This national ID belongs to Omar Fathy.", matches: [{ id: omar.id, field: "nationalId" }] });

      const passport = await post({ fullName: "Passport Again", nationalId: "a12345678" });
      expect(passport.res.status).toBe(409);
      expect(passport.json.error).toBe("duplicate_national_id");

      const both = await post({ fullName: "Sara Again", phone: "+201001234567", nationalId: "29801011234567" });
      expect(both.res.status).toBe(409);
      expect(both.json.error).toBe("duplicate_national_id");
      expect(both.json.matches).toEqual(
        expect.arrayContaining([
          { id: sara.id, fullName: "Sara Ibrahim", field: "phone" },
          { id: omar.id, fullName: "Omar Fathy", field: "nationalId" },
        ]),
      );

      const confirmed = await post({ fullName: "Omar Twin", nationalId: "29801011234567", confirmDuplicate: true });
      expect(confirmed.res.status).toBe(201);
    });
  });

  describe("editing", () => {
    it("checks a changed number against the other patients, never the patient's own", async () => {
      const p = (await post({ fullName: "Hala Nabil", phone: "+201003334444" })).json.patient as { id: string };
      expect((await patch(p.id, { phone: "+201003334444", city: "Giza" })).res.status).toBe(200);

      const taken = await patch(p.id, { phone: "010 0123 4567" });
      expect(taken.res.status).toBe(409);
      // Sara and the daughter saved earlier with the same number on purpose.
      expect(taken.json.error).toBe("duplicate_phone");
      expect(taken.json.matches).toEqual(expect.arrayContaining([{ id: sara.id, fullName: "Sara Ibrahim", field: "phone" }]));
      expect((await db.patient.findUniqueOrThrow({ where: { id: p.id } })).phone).toBe("+201003334444");

      const confirmed = await patch(p.id, { phone: "010 0123 4567", confirmDuplicate: true });
      expect(confirmed.res.status).toBe(200);
      expect(confirmed.json.patient.phone).toBe("01001234567");
      const log = await db.auditLog.findFirst({ where: { tenantId, action: "patient.update", entityId: p.id }, orderBy: { createdAt: "desc" } });
      expect(log?.after).toEqual({ phone: "01001234567", confirmedDuplicateOf: expect.arrayContaining([sara.id]) });
    });

    it("another tenant still gets 404, not a duplicate warning", async () => {
      const { res } = await patch(sara.id, { phone: "+201112223334" }, foreignOwner);
      expect(res.status).toBe(404);
    });
  });

  describe("date of birth", () => {
    it("refuses a date of birth more than 120 years ago or in the future", async () => {
      const now = new Date();
      const iso = (years: number, days = 0) =>
        new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + days)).toISOString().slice(0, 10);

      const ancient = await post({ fullName: "Too Old", dateOfBirth: iso(121) });
      expect(ancient.res.status).toBe(422);
      expect(ancient.json.issues.fieldErrors.dateOfBirth).toEqual(["Date of birth cannot be more than 120 years ago"]);
      expect((await post({ fullName: "Just Over", dateOfBirth: iso(120, -1) })).res.status).toBe(422);
      expect((await post({ fullName: "Centenarian", dateOfBirth: iso(119) })).res.status).toBe(201);
      expect((await post({ fullName: "Not Born", dateOfBirth: iso(0, 2) })).res.status).toBe(422);

      const p = (await post({ fullName: "Edit Me" })).json.patient as { id: string };
      expect((await patch(p.id, { dateOfBirth: iso(130) }, owner)).res.status).toBe(422);
    });
  });

  describe("paging", () => {
    it("shows the last page for a page past the end (?page=99), searched or not", async () => {
      const t = await createTenant();
      created.push(t.id);
      const cookie = await sessionCookieFor((await createUser({ tenantId: t.id, role: "RECEPTIONIST" })).id);
      const now = Date.now();
      await db.patient.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({ tenantId: t.id, fullName: `Paged ${i + 1}`, phone: `+20100000010${i}`, createdAt: new Date(now - (5 - i) * 60_000) })),
      });
      const page = async (qs: string) => {
        const res = await list(request(`/api/patients${qs}`, { cookie }));
        expect(res.status).toBe(200);
        return (await res.json()) as { patients: { fullName: string }[]; total: number; page: number };
      };
      const plain = await page("?pageSize=2&page=99");
      expect(plain).toMatchObject({ total: 5, page: 3 });
      expect(plain.patients.map((p) => p.fullName)).toEqual(["Paged 1"]);

      // The search path (exact phone matches first) clamps too.
      const searched = await page(`?q=${encodeURIComponent("+201000000104")}&pageSize=2&page=99`);
      expect(searched.page).toBe(1);
      expect(searched.patients.map((p) => p.fullName)).toEqual(["Paged 5"]);

      const sorted = await page("?pageSize=2&page=99&sort=last_visit");
      expect(sorted.page).toBe(3);
      expect(sorted.patients).toHaveLength(1);

      const none = await page("?q=nobody&page=99");
      expect(none).toMatchObject({ total: 0, page: 1, patients: [] });
    });
  });
});
