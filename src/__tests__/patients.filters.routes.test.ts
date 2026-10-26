/**
 * The patient registry's filters, sorting, exact lookup, CSV export and saved
 * views, over the real route handlers and the test database. Tenant A holds a
 * small, hand-built registry (every patient differs in exactly the attributes
 * the filters look at); tenant B proves nothing crosses the boundary.
 */
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dateKeyInTz } from "@/lib/time";
import { GET as listRoute } from "@/app/api/patients/route";
import { GET as exportRoute } from "@/app/api/patients/export/route";
import { GET as viewsListRoute, POST as viewsCreateRoute } from "@/app/api/patients/views/route";
import { DELETE as viewDeleteRoute, PATCH as viewPatchRoute } from "@/app/api/patients/views/[id]/route";
import { EXPORT_COLUMNS, csvCell, csvTextCell } from "@/modules/patients/export";
import { parsePatientListQuery, patientFiltersOnly } from "@/modules/patients/filters";
import { canonicalPhone, normalizeDigits, phoneVariants } from "@/modules/patients/search";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const DAY = 86_400_000;
const TZ = "Africa/Cairo";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Row = { id: string; fullName: string; exact: boolean; lastVisitAt: string | null; nextAppointmentAt: string | null };

/** Midnight UTC `years` (and `days`) before now: dates of birth are stored at UTC midnight. */
function born(years: number, days = 30): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()) - days * DAY);
}

describe("patient list query parsing (pure)", () => {
  it("keeps known values, drops unknown ones and stale bookmarks still parse", () => {
    const q = parsePatientListQuery(
      new URLSearchParams("q=%20Sara%20&gender=FEMALE&age=99-120&tag=vip&upcoming=soon&visit=90&reg=custom&from=2026-01-01&to=bad&lang=fr&sort=name_desc&page=3&evil=1"),
    );
    expect(q).toEqual({ q: "Sara", gender: "FEMALE", tag: "vip", visit: "90", reg: "custom", from: "2026-01-01", sort: "name_desc", page: 3 });
    // A custom range without either bound is no filter at all.
    expect(parsePatientListQuery(new URLSearchParams("reg=custom"))).toEqual({});
    expect(patientFiltersOnly(q)).toEqual({ q: "Sara", gender: "FEMALE", tag: "vip", visit: "90", reg: "custom", from: "2026-01-01", sort: "name_desc" });
  });

  it("spells an Egyptian mobile every way the desk may have stored it", () => {
    expect(normalizeDigits("٠١٠١٢٣٤٥٦٧٨")).toBe("01012345678");
    for (const typed of ["01012345678", "+20 10 1234 5678", "0020 101 234 5678", "٠١٠١٢٣٤٥٦٧٨", "+٢٠١٠١٢٣٤٥٦٧٨"]) {
      expect(phoneVariants(typed)).toEqual(expect.arrayContaining(["+201012345678", "01012345678", "201012345678", "00201012345678"]));
      expect(canonicalPhone(typed)).toBe("+201012345678");
    }
    expect(phoneVariants("12")).toEqual([]);
  });

  it("writes CSV cells that a spreadsheet cannot execute and that keep long digit strings as text", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(csvCell("Hair, scalp")).toBe(`"Hair, scalp"`);
    expect(csvCell("+201012345678")).toBe(`"=""+201012345678"""`);
    expect(csvTextCell("29801011234567")).toBe(`"=""29801011234567"""`);
    expect(csvTextCell("01012345678")).toBe(`"=""01012345678"""`);
    expect(csvTextCell("A1234567")).toBe("A1234567");
    expect(csvTextCell(null)).toBe("");
  });
});

describe.skipIf(!dbTestsEnabled)("patients filters, sorting, export and saved views", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let ownerA: { id: string };
  let deskA: { id: string };
  let doctor1: { id: string };
  let doctor2: { id: string };
  let ownerCookie: string;
  let deskCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  const P: Record<"amira" | "bassem" | "carmen" | "dalia" | "ehab" | "fady", string> = {
    amira: "",
    bassem: "",
    carmen: "",
    dalia: "",
    ehab: "",
    fady: "",
  };

  async function list(qs: string, cookie = ownerCookie) {
    const res = await listRoute(request(`/api/patients${qs ? `?${qs}` : ""}`, { cookie }));
    const json = (await res.json()) as { patients: Row[]; total: number; page: number; pageSize: number };
    return { res, json, names: (json.patients ?? []).map((p) => p.fullName) };
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `pfilt-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `pfilt-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA.id;
    b = tenantB.id;

    ownerA = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    deskA = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    doctor1 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. One" });
    doctor2 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Two" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(ownerA.id);
    deskCookie = await sessionCookieFor(deskA.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);

    const now = Date.now();
    const patient = (data: Omit<Prisma.PatientUncheckedCreateInput, "tenantId">) =>
      db.patient.create({ data: { ...data, tenantId: a }, select: { id: true } });

    P.bassem = (
      await patient({
        fullName: "Bassem Nabil",
        gender: "MALE",
        dateOfBirth: born(50),
        tags: ["acne"],
        language: "en",
        source: "WALK_IN",
        // Stored the local way: "+20 10 2222 3333" typed at the desk must still find it.
        phone: "01022223333",
        createdAt: new Date(now - 100 * DAY),
      })
    ).id;
    P.carmen = (
      await patient({
        fullName: "Carmen Hany",
        gender: "FEMALE",
        dateOfBirth: born(15),
        language: "ar",
        source: "CLICK_TO_WHATSAPP_AD",
        phone: "+201033334444",
        whatsapp: "+201099998888",
        createdAt: new Date(now - 40 * DAY),
      })
    ).id;
    P.amira = (
      await patient({
        fullName: "Amira Fathy",
        gender: "FEMALE",
        dateOfBirth: born(25),
        tags: ["vip", "hair-transplant"],
        language: "ar",
        source: "REFERRAL",
        phone: "+201011112222",
        nationalId: "29801011234567",
        city: "Cairo",
        email: "amira@example.test",
        createdAt: new Date(now - 2 * DAY),
      })
    ).id;
    P.dalia = (
      await patient({
        fullName: "Dalia Samir",
        gender: "FEMALE",
        tags: ["vip"],
        language: "en",
        nationalId: "A12345678",
        createdAt: new Date(now - 400 * DAY),
        deletedAt: new Date(now - DAY),
      })
    ).id;
    P.ehab = (
      await patient({
        fullName: "Ehab Kamel",
        gender: "MALE",
        dateOfBirth: born(70),
        tags: ["hair-transplant"],
        language: "ar",
        phone: "+201044445555",
        createdAt: new Date(now - 60_000),
      })
    ).id;
    // Newer than Ehab, and its national id merely *contains* Ehab's local number.
    P.fady = (
      await patient({ fullName: "Fady Kamel", gender: "MALE", language: "ar", nationalId: "29101044445555", createdAt: new Date(now - 30_000) })
    ).id;

    // Visits: Amira 10 days ago (doctor 1), Bassem 200 days ago, Dalia (archived) 50 days ago.
    await db.visit.createMany({
      data: [
        { tenantId: a, patientId: P.amira, doctorId: doctor1.id, createdAt: new Date(now - 10 * DAY) },
        { tenantId: a, patientId: P.bassem, doctorId: doctor2.id, createdAt: new Date(now - 200 * DAY) },
        { tenantId: a, patientId: P.dalia, doctorId: doctor1.id, createdAt: new Date(now - 50 * DAY) },
      ],
    });
    // Upcoming: Amira in 3 days with doctor 1, Carmen in 20 days with doctor 2; Ehab's only booking is cancelled.
    const appt = (patientId: string, doctorId: string, inDays: number, status: "SCHEDULED" | "CANCELLED" = "SCHEDULED") => ({
      tenantId: a,
      patientId,
      doctorId,
      startsAt: new Date(now + inDays * DAY),
      endsAt: new Date(now + inDays * DAY + 30 * 60_000),
      status,
    });
    await db.appointment.createMany({
      data: [appt(P.amira, doctor1.id, 3), appt(P.carmen, doctor2.id, 20), appt(P.ehab, doctor1.id, 5, "CANCELLED")],
    });

    // Tenant B has a patient with Amira's exact phone: it must never surface in A, nor A's in B.
    await db.patient.create({ data: { tenantId: b, fullName: "Other Clinic Patient", phone: "+201011112222", tags: ["vip"] } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("each filter narrows the list", () => {
    it("lists every active patient without filters, newest first", async () => {
      const { res, json, names } = await list("");
      expect(res.status).toBe(200);
      expect(json.total).toBe(5);
      expect(names).toEqual(["Fady Kamel", "Ehab Kamel", "Amira Fathy", "Carmen Hany", "Bassem Nabil"]);
    });

    it.each([
      ["gender=FEMALE", ["Amira Fathy", "Carmen Hany"]],
      ["gender=MALE", ["Fady Kamel", "Ehab Kamel", "Bassem Nabil"]],
      ["age=u18", ["Carmen Hany"]],
      ["age=18-30", ["Amira Fathy"]],
      ["age=46-60", ["Bassem Nabil"]],
      ["age=60p", ["Ehab Kamel"]],
      ["tag=vip", ["Amira Fathy"]],
      ["tag=hair-transplant", ["Ehab Kamel", "Amira Fathy"]],
      ["upcoming=yes", ["Amira Fathy", "Carmen Hany"]],
      ["upcoming=week", ["Amira Fathy"]],
      ["upcoming=no", ["Fady Kamel", "Ehab Kamel", "Bassem Nabil"]],
      ["visit=30", ["Amira Fathy"]],
      ["visit=180", ["Amira Fathy"]],
      ["visit=over180", ["Bassem Nabil"]],
      ["visit=never", ["Fady Kamel", "Ehab Kamel", "Carmen Hany"]],
      ["lang=en", ["Bassem Nabil"]],
      ["source=REFERRAL", ["Amira Fathy"]],
      ["source=CLICK_TO_WHATSAPP_AD", ["Carmen Hany"]],
      ["archived=only", ["Dalia Samir"]],
      ["archived=1&tag=vip", ["Amira Fathy", "Dalia Samir"]],
      ["gender=FEMALE&upcoming=yes&lang=ar&age=18-30", ["Amira Fathy"]],
    ])("%s", async (qs, expected) => {
      const { res, json, names } = await list(qs);
      expect(res.status).toBe(200);
      expect(names).toEqual(expected);
      expect(json.total).toBe(expected.length);
    });

    it("filters by doctor: an upcoming booking or a past visit with them", async () => {
      expect((await list(`doctor=${doctor1.id}`)).names).toEqual(["Amira Fathy"]);
      expect((await list(`doctor=${doctor2.id}`)).names).toEqual(["Carmen Hany", "Bassem Nabil"]);
    });

    it("filters by registration date: this week, or a custom range on the clinic clock", async () => {
      const week = (await list("reg=week")).names;
      expect(week).toEqual(expect.arrayContaining(["Fady Kamel", "Ehab Kamel"]));
      expect(week).not.toContain("Bassem Nabil");
      const from = dateKeyInTz(new Date(Date.now() - 101 * DAY), TZ);
      const to = dateKeyInTz(new Date(Date.now() - 99 * DAY), TZ);
      expect((await list(`reg=custom&from=${from}&to=${to}`)).names).toEqual(["Bassem Nabil"]);
      expect((await list(`reg=custom&from=${dateKeyInTz(new Date(Date.now() - 45 * DAY), TZ)}`)).names).toEqual([
        "Fady Kamel",
        "Ehab Kamel",
        "Amira Fathy",
        "Carmen Hany",
      ]);
    });

    it("ignores unknown filter values instead of failing", async () => {
      const { res, json } = await list("gender=ROBOT&age=200&visit=yesterday&sort=random");
      expect(res.status).toBe(200);
      expect(json.total).toBe(5);
    });

    it("pages the filtered set", async () => {
      const first = await list("pageSize=2&sort=name_asc");
      const second = await list("pageSize=2&page=2&sort=name_asc");
      expect(first.json).toMatchObject({ total: 5, page: 1, pageSize: 2 });
      expect(first.names).toEqual(["Amira Fathy", "Bassem Nabil"]);
      expect(second.names).toEqual(["Carmen Hany", "Ehab Kamel"]);
    });
  });

  describe("sorting", () => {
    it.each([
      ["name_asc", ["Amira Fathy", "Bassem Nabil", "Carmen Hany", "Ehab Kamel", "Fady Kamel"]],
      ["name_desc", ["Fady Kamel", "Ehab Kamel", "Carmen Hany", "Bassem Nabil", "Amira Fathy"]],
      ["oldest", ["Bassem Nabil", "Carmen Hany", "Amira Fathy", "Ehab Kamel", "Fady Kamel"]],
      ["newest", ["Fady Kamel", "Ehab Kamel", "Amira Fathy", "Carmen Hany", "Bassem Nabil"]],
      // Patients without a visit / an upcoming booking / a date of birth come last, newest first.
      ["last_visit", ["Amira Fathy", "Bassem Nabil", "Fady Kamel", "Ehab Kamel", "Carmen Hany"]],
      ["next_appointment", ["Amira Fathy", "Carmen Hany", "Fady Kamel", "Ehab Kamel", "Bassem Nabil"]],
      ["age_desc", ["Ehab Kamel", "Bassem Nabil", "Amira Fathy", "Carmen Hany", "Fady Kamel"]],
      ["age_asc", ["Carmen Hany", "Amira Fathy", "Bassem Nabil", "Ehab Kamel", "Fady Kamel"]],
    ])("sort=%s", async (sort, expected) => {
      expect((await list(`sort=${sort}`)).names).toEqual(expected);
    });

    it("carries each row's last visit and next appointment", async () => {
      const { json } = await list("sort=next_appointment");
      const amira = json.patients.find((p) => p.id === P.amira)!;
      const ehab = json.patients.find((p) => p.id === P.ehab)!;
      expect(amira.lastVisitAt).toBeTruthy();
      expect(amira.nextAppointmentAt).toBeTruthy();
      // A cancelled booking is not an upcoming appointment.
      expect(ehab.nextAppointmentAt).toBeNull();
    });
  });

  describe("exact phone and national id lookup", () => {
    it.each([
      ["local form", "01044445555"],
      ["Arabic-Indic digits", "٠١٠٤٤٤٤٥٥٥٥"],
      ["+20 prefix with spaces", "+20 10 4444 5555"],
      ["0020 prefix", "00201044445555"],
    ])("lists the exact phone match first (%s), before newer partial matches", async (_label, typed) => {
      const { json } = await list(`q=${encodeURIComponent(typed)}`);
      expect(json.patients[0]).toMatchObject({ id: P.ehab, exact: true });
      for (const other of json.patients.slice(1)) expect(other.exact).toBe(false);
    });

    it("finds a number stored in local form when it is typed with +20", async () => {
      const { json } = await list(`q=${encodeURIComponent("+20 10 2222 3333")}`);
      expect(json.patients.map((p) => p.id)).toEqual([P.bassem]);
      expect(json.patients[0]!.exact).toBe(true);
    });

    it("matches the WhatsApp number exactly too", async () => {
      const { json } = await list(`q=${encodeURIComponent("٠١٠٩٩٩٩٨٨٨٨")}`);
      expect(json.patients[0]).toMatchObject({ id: P.carmen, exact: true });
    });

    it("matches a national id exactly, and a partial one without the exact flag", async () => {
      const exact = await list("q=29801011234567");
      expect(exact.json.patients).toHaveLength(1);
      expect(exact.json.patients[0]).toMatchObject({ id: P.amira, exact: true });
      const partial = await list("q=2980101");
      expect(partial.json.patients[0]).toMatchObject({ id: P.amira, exact: false });
      const arabic = await list(`q=${encodeURIComponent("٢٩٨٠١٠١١٢٣٤٥٦٧")}`);
      expect(arabic.json.patients[0]).toMatchObject({ id: P.amira, exact: true });
    });

    it("matches a passport number case-insensitively (archived included on request)", async () => {
      expect((await list("q=a12345678")).json.total).toBe(0);
      const { json } = await list("q=a12345678&archived=1");
      expect(json.patients[0]).toMatchObject({ id: P.dalia, exact: true });
    });

    it("never returns another tenant's patient for the same phone", async () => {
      const { json } = await list(`q=${encodeURIComponent("01011112222")}`, ownerBCookie);
      expect(json.patients.map((p) => p.fullName)).toEqual(["Other Clinic Patient"]);
      const own = await list(`q=${encodeURIComponent("01011112222")}`);
      expect(own.json.patients.map((p) => p.id)).toEqual([P.amira]);
    });
  });

  describe("CSV export", () => {
    it("exports the filtered rows with a UTF-8 BOM and the header, and audits the export", async () => {
      const res = await exportRoute(request("/api/patients/export?tag=hair-transplant&sort=name_asc", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="patients-\d{2}-\d{2}-\d{4}\.csv"$/);
      expect(res.headers.get("x-row-count")).toBe("2");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      expect(text.charCodeAt(0)).toBe(0xfeff);
      const lines = text.slice(1).trimEnd().split("\r\n");
      expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatch(/^Amira Fathy,FEMALE,25,"=""\+201011112222""",,amira@example\.test,"=""29801011234567""",Cairo,ar,"vip; hair-transplant",/);
      expect(lines[2]).toMatch(/^Ehab Kamel,MALE,70,/);
      expect(text).not.toContain("Bassem");

      const audits = await db.auditLog.findMany({ where: { tenantId: a, action: "patient.export" } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: ownerA.id, entity: "Patient" });
      expect(audits[0]!.after).toMatchObject({ filters: { tag: "hair-transplant", sort: "name_asc" }, rows: 2, total: 2, format: "csv" });
    });

    it("applies the search too, and another tenant's export holds none of A's rows", async () => {
      const mine = await exportRoute(request(`/api/patients/export?q=${encodeURIComponent("+20 10 4444 5555")}`, { cookie: ownerCookie }));
      expect((await mine.text()).split("\r\n")[1]).toMatch(/^Ehab Kamel,/);
      const theirs = await exportRoute(request("/api/patients/export", { cookie: ownerBCookie }));
      const text = await theirs.text();
      expect(text).toContain("Other Clinic Patient");
      expect(text).not.toContain("Amira");
    });

    it("requires a session and is an owner action: reception and assistants get 403", async () => {
      expect((await exportRoute(request("/api/patients/export"))).status).toBe(401);
      expect((await exportRoute(request("/api/patients/export", { cookie: assistantCookie }))).status).toBe(403);
      expect((await exportRoute(request("/api/patients/export", { cookie: deskCookie }))).status).toBe(403);
    });
  });

  describe("saved views", () => {
    let viewId: string;

    it("creates a view for the caller, keeping only known filter keys", async () => {
      const res = await viewsCreateRoute(
        request("/api/patients/views", {
          method: "POST",
          cookie: ownerCookie,
          body: { name: "  VIP women  ", params: { tag: "vip", gender: "FEMALE", sort: "name_asc", evil: "drop table", age: "999" } },
        }),
      );
      expect(res.status).toBe(201);
      const { view } = await res.json();
      expect(view).toMatchObject({ name: "VIP women", params: { tag: "vip", gender: "FEMALE", sort: "name_asc" } });
      expect(view.params).not.toHaveProperty("evil");
      expect(view.params).not.toHaveProperty("age");
      viewId = view.id;
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "patient.view.create", entityId: viewId } });
      expect(audit?.actorId).toBe(ownerA.id);
    });

    it("validates the name", async () => {
      const res = await viewsCreateRoute(request("/api/patients/views", { method: "POST", cookie: ownerCookie, body: { name: "  ", params: {} } }));
      expect(res.status).toBe(422);
      const long = await viewsCreateRoute(request("/api/patients/views", { method: "POST", cookie: ownerCookie, body: { name: "x".repeat(61), params: {} } }));
      expect(long.status).toBe(422);
    });

    it("lists only the caller's views", async () => {
      const mine = await (await viewsListRoute(request("/api/patients/views", { cookie: ownerCookie }))).json();
      expect(mine.views.map((v: { id: string }) => v.id)).toEqual([viewId]);
      const desk = await (await viewsListRoute(request("/api/patients/views", { cookie: deskCookie }))).json();
      expect(desk.views).toEqual([]);
      const other = await (await viewsListRoute(request("/api/patients/views", { cookie: ownerBCookie }))).json();
      expect(other.views).toEqual([]);
    });

    it("another user's view is a 404 for rename and delete, in the same tenant and across tenants", async () => {
      for (const cookie of [deskCookie, ownerBCookie]) {
        const patch = await viewPatchRoute(request(`/api/patients/views/${viewId}`, { method: "PATCH", cookie, body: { name: "Mine now" } }), params(viewId));
        expect(patch.status).toBe(404);
        const del = await viewDeleteRoute(request(`/api/patients/views/${viewId}`, { method: "DELETE", cookie }), params(viewId));
        expect(del.status).toBe(404);
      }
      const still = await db.savedView.findUnique({ where: { id: viewId } });
      expect(still?.name).toBe("VIP women");
    });

    it("renames and replaces the filters of the caller's own view", async () => {
      const renamed = await viewPatchRoute(
        request(`/api/patients/views/${viewId}`, { method: "PATCH", cookie: ownerCookie, body: { name: "VIP (all)" } }),
        params(viewId),
      );
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).view).toMatchObject({ name: "VIP (all)", params: { tag: "vip", gender: "FEMALE" } });
      const refiltered = await viewPatchRoute(
        request(`/api/patients/views/${viewId}`, { method: "PATCH", cookie: ownerCookie, body: { params: { tag: "vip", archived: "1" } } }),
        params(viewId),
      );
      expect((await refiltered.json()).view.params).toEqual({ tag: "vip", archived: "1" });
      const bad = await viewPatchRoute(
        request(`/api/patients/views/${viewId}`, { method: "PATCH", cookie: ownerCookie, body: { name: "" } }),
        params(viewId),
      );
      expect(bad.status).toBe(422);
    });

    it("a saved view's parameters reproduce the list", async () => {
      const row = await db.savedView.findUniqueOrThrow({ where: { id: viewId } });
      const qs = new URLSearchParams(row.params as Record<string, string>).toString();
      expect((await list(qs)).names).toEqual(["Amira Fathy", "Dalia Samir"]);
    });

    it("deletes the caller's own view", async () => {
      const del = await viewDeleteRoute(request(`/api/patients/views/${viewId}`, { method: "DELETE", cookie: ownerCookie }), params(viewId));
      expect(del.status).toBe(200);
      const after = await (await viewsListRoute(request("/api/patients/views", { cookie: ownerCookie }))).json();
      expect(after.views).toEqual([]);
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "patient.view.delete", entityId: viewId } });
      expect(audit).not.toBeNull();
    });

    it("refuses cross-origin writes and requires a session", async () => {
      const res = await viewsCreateRoute(
        request("/api/patients/views", { method: "POST", cookie: ownerCookie, body: { name: "x", params: {} }, headers: { origin: "https://evil.example" } }),
      );
      expect(res.status).toBe(403);
      expect((await viewsListRoute(request("/api/patients/views"))).status).toBe(401);
    });
  });
});
