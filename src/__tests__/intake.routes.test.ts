/**
 * Shareable onboarding links and the public form, over the real route
 * handlers and the test database: issuing a link (URL, QR, WhatsApp share),
 * the token-only public GET/POST and every way a token is dead, the review
 * queue (accept as new, merge by phone, reject), RBAC, tenant isolation and
 * the reception notification.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { GET as linksListRoute, POST as linksCreateRoute } from "@/app/api/intake/links/route";
import { POST as revokeRoute } from "@/app/api/intake/links/[id]/revoke/route";
import { GET as submissionsRoute } from "@/app/api/intake/submissions/route";
import { POST as acceptRoute } from "@/app/api/intake/submissions/[id]/accept/route";
import { POST as rejectRoute } from "@/app/api/intake/submissions/[id]/reject/route";
import { GET as publicGetRoute, POST as publicPostRoute } from "@/app/api/public/intake/[token]/route";
import { linkStatus, whatsappShare } from "@/modules/intake/service";
import { hashIntakeToken, issueIntakeToken } from "@/modules/intake/tokens";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

/** A complete, valid public form; override what a test cares about. */
function form(overrides: Record<string, unknown> = {}) {
  return {
    language: "en",
    fullName: "Nour Hassan",
    phone: "0101 777 8888",
    whatsappSame: true,
    dateOfBirth: "1992-04-11",
    gender: "FEMALE",
    city: "Maadi",
    nationalId: "29204110101234",
    email: "Nour@Example.test",
    address: "Road 9, Maadi",
    emergencyContactName: "Ali Hassan",
    emergencyContactPhone: "01229998877",
    emergencyContactRelation: "Father",
    treatmentKeys: ["acne", "not-a-treatment"],
    concern: "Breakouts on the jawline",
    sinceWhen: "One year",
    chronicConditions: ["Asthma", "asthma "],
    allergies: ["Sulfa drugs"],
    medications: [{ name: "Ventolin", dose: "2 puffs as needed" }],
    surgeries: [],
    consent: true,
    whatsappUpdates: true,
    ...overrides,
  };
}

describe("intake helpers (pure)", () => {
  it("derives a link's status from revocation, expiry and uses", () => {
    const now = new Date("2026-10-26T10:00:00Z");
    const base = { revokedAt: null, expiresAt: new Date("2026-11-01T00:00:00Z"), maxUses: null, uses: 3 };
    expect(linkStatus(base, now)).toBe("active");
    expect(linkStatus({ ...base, revokedAt: now }, now)).toBe("revoked");
    expect(linkStatus({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(linkStatus({ ...base, maxUses: 3 }, now)).toBe("exhausted");
  });

  it("writes the WhatsApp invitation in the patient's language and addresses their number", () => {
    const ar = whatsappShare({ url: "https://x.test/onboard/t", language: "ar", clinicName: "Aura", patientName: "Salma", phone: "+20 10 5555 6666" });
    expect(ar.message).toContain("مرحباً Salma");
    expect(ar.message).toContain("https://x.test/onboard/t");
    expect(ar.whatsappUrl.startsWith("https://wa.me/201055556666?text=")).toBe(true);
    const en = whatsappShare({ url: "https://x.test/onboard/t", language: "en", clinicName: "Aura" });
    expect(en.message).toBe("Hello, please fill in your onboarding form for Aura before your visit (about 3 minutes): https://x.test/onboard/t");
    expect(en.whatsappUrl).toBe(`https://wa.me/?text=${encodeURIComponent(en.message)}`);
  });
});

describe.skipIf(!dbTestsEnabled)("intake routes", () => {
  const created: string[] = [];
  let a: { id: string; slug: string; name: string };
  let b: { id: string; slug: string };
  let owner: { id: string };
  let desk: { id: string };
  let doctor: { id: string };
  let ownerCookie: string;
  let deskCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let salma: string;
  let patientB: string;
  let deskLink: { id: string; token: string };
  let ip = 0;

  /** Each public call comes from its own address unless a test says otherwise (the routes rate-limit per IP). */
  const publicHeaders = (extra: Record<string, string> = {}) => ({ "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });

  async function createLink(body: Record<string, unknown>, cookie = deskCookie) {
    const res = await linksCreateRoute(request("/api/intake/links", { method: "POST", cookie, body }));
    const json = await res.json();
    return { res, json, token: typeof json.url === "string" ? (json.url.split("/onboard/")[1] as string) : "" };
  }

  async function publicGet(token: string, headers: Record<string, string> = {}) {
    const res = await publicGetRoute(request(`/api/public/intake/${token}`, { headers: publicHeaders(headers) }), tokenParams(token));
    return { res, json: await res.json() };
  }

  async function publicPost(token: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await publicPostRoute(request(`/api/public/intake/${token}`, { method: "POST", body, headers: publicHeaders(headers) }), tokenParams(token));
    return { res, json: await res.json() };
  }

  async function submissionFor(fullName: string, tenantId = a.id) {
    return db.intakeSubmission.findFirstOrThrow({ where: { tenantId, fullName }, orderBy: { submittedAt: "desc" } });
  }

  async function accept(id: string, body: unknown, cookie = deskCookie) {
    const res = await acceptRoute(request(`/api/intake/submissions/${id}/accept`, { method: "POST", cookie, body }), idParams(id));
    return { res, json: await res.json() };
  }

  async function reject(id: string, body: unknown, cookie = deskCookie) {
    const res = await rejectRoute(request(`/api/intake/submissions/${id}/reject`, { method: "POST", cookie, body }), idParams(id));
    return { res, json: await res.json() };
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `intake-a-${Date.now().toString(36)}`, name: "Aura Test Clinic" });
    const tenantB = await createTenant({ slug: `intake-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    b = tenantB;
    owner = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Owner A" });
    desk = await createUser({ tenantId: a.id, role: "RECEPTIONIST", fullName: "Desk A" });
    doctor = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a.id, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    deskCookie = await sessionCookieFor(desk.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);

    salma = (
      await db.patient.create({
        data: {
          tenantId: a.id,
          fullName: "Salma Fouad",
          gender: "FEMALE",
          phone: "+201055556666",
          whatsapp: "+201055556666",
          email: "salma@old.test",
          tags: ["vip"],
          language: "ar",
          medicalHistory: { create: { tenantId: a.id, chronicConditions: ["Hypothyroidism"], allergies: ["Penicillin"] } },
          medications: { create: { tenantId: a.id, name: "Levothyroxine", dosage: "50 mcg", active: true } },
        },
      })
    ).id;
    patientB = (await db.patient.create({ data: { tenantId: b.id, fullName: "Patient Of B", phone: "+201066667777" } })).id;
  });

  beforeEach(() => resetRateLimits());

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("issuing links", () => {
    it("creates an open link: URL, QR data URL and WhatsApp share, shown once, stored hashed and audited", async () => {
      const { res, json, token } = await createLink({ kind: "OPEN", label: "Reception desk QR", language: "ar", expiresInDays: 30 });
      expect(res.status).toBe(201);
      expect(json.url).toBe(`${(env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "")}/onboard/${token}`);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(json.qrDataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/);
      expect(json.whatsappUrl).toBe(`https://wa.me/?text=${encodeURIComponent(json.message)}`);
      expect(json.message).toContain(a.name);
      expect(json.message).toContain(json.url);
      expect(json.link).toMatchObject({ kind: "OPEN", label: "Reception desk QR", language: "ar", uses: 0, maxUses: null, status: "active", tokenPrefix: token.slice(0, 8), createdBy: { id: desk.id, fullName: "Desk A" } });
      const days = (new Date(json.link.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);

      const row = await db.intakeLink.findUniqueOrThrow({ where: { id: json.link.id } });
      expect(row.tokenHash).toBe(hashIntakeToken(token));
      expect(JSON.stringify(row)).not.toContain(token);
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "intake.link.create", entityId: row.id } });
      expect(audit.actorId).toBe(desk.id);
      expect(JSON.stringify(audit)).not.toContain(token);
      deskLink = { id: row.id, token };
    });

    it("creates a patient link addressed to the patient's WhatsApp, in their language", async () => {
      const { res, json } = await createLink({ kind: "PATIENT", patientId: salma, language: "ar", maxUses: 1 });
      expect(res.status).toBe(201);
      expect(json.link).toMatchObject({ kind: "PATIENT", patient: { id: salma, fullName: "Salma Fouad" }, maxUses: 1 });
      expect(json.whatsappUrl.startsWith("https://wa.me/201055556666?text=")).toBe(true);
      expect(json.message).toContain("Salma Fouad");
    });

    it("validates the body: a patient link needs a patient of this tenant", async () => {
      expect((await createLink({ kind: "PATIENT" })).res.status).toBe(422);
      expect((await createLink({ kind: "PATIENT", patientId: patientB })).res.status).toBe(404);
      expect((await createLink({ kind: "OPEN", expiresInDays: 0 })).res.status).toBe(422);
      expect((await createLink({ kind: "OPEN", expiresInDays: 400 })).res.status).toBe(422);
      expect((await createLink({ kind: "OPEN", language: "fr" })).res.status).toBe(422);
      expect((await createLink({ kind: "SOMEONE" })).res.status).toBe(422);
      expect((await createLink({ kind: "OPEN", maxUses: 0 })).res.status).toBe(422);
    });

    it("lists the tenant's links with their status; another tenant sees none of them", async () => {
      const mine = await (await linksListRoute(request("/api/intake/links", { cookie: ownerCookie }))).json();
      expect(mine.links.map((l: { id: string }) => l.id)).toContain(deskLink.id);
      const theirs = await (await linksListRoute(request("/api/intake/links", { cookie: ownerBCookie }))).json();
      expect(theirs.total).toBe(0);
    });
  });

  describe("public form", () => {
    it("GET returns what the form needs, without the token or any patient data on an open link", async () => {
      const { res, json } = await publicGet(deskLink.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(json).toMatchObject({ clinicName: "Aura Test Clinic", language: "ar", kind: "OPEN", label: "Reception desk QR", prefill: null });
      expect(json.treatments.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(["hair-transplant", "acne", "pigmentation"]));
      expect(JSON.stringify(json)).not.toContain(deskLink.token);
    });

    it("GET pre-fills a patient link with what the clinic knows", async () => {
      const { token } = await createLink({ kind: "PATIENT", patientId: salma, language: "en" });
      const { json } = await publicGet(token);
      expect(json).toMatchObject({ kind: "PATIENT", language: "en", prefill: { fullName: "Salma Fouad", phone: "+201055556666", email: "salma@old.test", gender: "FEMALE" } });
    });

    it("POST stores a PENDING submission, canonicalises the answers and bumps the link's uses", async () => {
      const { res, json } = await publicPost(deskLink.token, form());
      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true });
      const s = await submissionFor("Nour Hassan");
      expect(s).toMatchObject({ status: "PENDING", phone: "+201017778888", email: "nour@example.test", linkId: deskLink.id, matchedPatientId: null });
      expect(s.data).toMatchObject({
        language: "en",
        phone: "+201017778888",
        emergencyContactPhone: "+201229998877",
        treatmentKeys: ["acne"],
        chronicConditions: ["Asthma"],
        medications: [{ name: "Ventolin", dose: "2 puffs as needed" }],
        consent: true,
      });
      expect((await db.intakeLink.findUniqueOrThrow({ where: { id: deskLink.id } })).uses).toBe(1);
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "intake.submission.create", entityId: s.id } });
      expect(audit.actorId).toBeNull();
    });

    it("notifies reception and the owner (not the doctor) that a form arrived", async () => {
      const s = await submissionFor("Nour Hassan");
      await vi.waitFor(
        async () => {
          const rows = await db.notification.findMany({ where: { tenantId: a.id, kind: "INTAKE_SUBMITTED", entityId: s.id } });
          expect(rows.map((r) => r.userId).sort()).toEqual([owner.id, desk.id].sort());
        },
        { timeout: 3000, interval: 50 },
      );
      const row = await db.notification.findFirstOrThrow({ where: { tenantId: a.id, kind: "INTAKE_SUBMITTED", entityId: s.id, userId: desk.id } });
      expect(row).toMatchObject({ title: "Onboarding form received", href: "/dashboard/patients/intake", entity: "IntakeSubmission" });
      expect(row.body).toContain("Nour Hassan");
      expect(await db.notification.count({ where: { tenantId: a.id, userId: doctor.id, kind: "INTAKE_SUBMITTED" } })).toBe(0);
    });

    it("matches an existing patient by phone, whatever the spelling (Arabic-Indic digits, +20)", async () => {
      const { res } = await publicPost(
        deskLink.token,
        form({ language: "ar", fullName: "سلمى فؤاد", phone: "٠١٠٥٥٥٥٦٦٦٦", email: "salma.new@example.test", city: "الجيزة", nationalId: "٢٩٠٠١٠١٠١٠١٠١٠", dateOfBirth: "١٩٩٠-٠١-٠١", treatmentKeys: ["pigmentation"], chronicConditions: ["hypothyroidism", "Asthma"], allergies: ["PENICILLIN", "Latex"], medications: [{ name: "levothyroxine", dose: "75 mcg" }, { name: "Ventolin" }], surgeries: ["Appendectomy"] }),
      );
      expect(res.status).toBe(200);
      const s = await submissionFor("سلمى فؤاد");
      expect(s).toMatchObject({ phone: "+201055556666", matchedPatientId: salma });
      expect(s.data).toMatchObject({ nationalId: "29001010101010", dateOfBirth: "1990-01-01" });
    });

    it("POST validates the form (422), and a form without consent is not stored", async () => {
      const before = await db.intakeSubmission.count({ where: { tenantId: a.id } });
      const noConsent = await publicPost(deskLink.token, form({ fullName: "No Consent", consent: false }));
      expect(noConsent.res.status).toBe(422);
      const badPhone = await publicPost(deskLink.token, form({ fullName: "Bad Phone", phone: "12" }));
      expect(badPhone.res.status).toBe(422);
      expect(badPhone.json.issues.fieldErrors.phone).toBeTruthy();
      const empty = await publicPost(deskLink.token, {});
      expect(empty.res.status).toBe(422);
      expect(await db.intakeSubmission.count({ where: { tenantId: a.id } })).toBe(before);
    });

    it("an unlimited link takes simultaneous submissions", async () => {
      const results = await Promise.all([
        publicPost(deskLink.token, form({ fullName: "Same Time One", phone: "01111111111" })),
        publicPost(deskLink.token, form({ fullName: "Same Time Two", phone: "01111111112" })),
        publicPost(deskLink.token, form({ fullName: "Same Time Three", phone: "01111111113" })),
      ]);
      expect(results.map((r) => r.res.status)).toEqual([200, 200, 200]);
    });

    it("rate-limits submissions per address", async () => {
      const headers = { "x-forwarded-for": "10.200.0.1" };
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await publicPostRoute(
          request(`/api/public/intake/${deskLink.token}`, { method: "POST", body: {}, headers }),
          tokenParams(deskLink.token),
        );
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe("dead tokens are a plain 404, indistinguishable from an unknown one", () => {
    async function expectDead(token: string, headers: Record<string, string> = {}) {
      const get = await publicGet(token, headers);
      expect(get.res.status).toBe(404);
      expect(get.json).toEqual({ error: "not_found" });
      const post = await publicPost(token, form({ fullName: "Should Not Land" }), headers);
      expect(post.res.status).toBe(404);
      expect(post.json).toEqual({ error: "not_found" });
    }

    it("unknown and malformed tokens", async () => {
      await expectDead(issueIntakeToken().token);
      await expectDead("short");
      await expectDead("x".repeat(129));
      await expectDead("has spaces and ünïcode !!");
    });

    it("an expired link", async () => {
      const { json, token } = await createLink({ kind: "OPEN" });
      await db.intakeLink.update({ where: { id: json.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expectDead(token);
    });

    it("a revoked link (revoking is audited and idempotent)", async () => {
      const { json, token } = await createLink({ kind: "OPEN", label: "Old flyer" });
      expect((await publicGet(token)).res.status).toBe(200);
      const res = await revokeRoute(request(`/api/intake/links/${json.link.id}/revoke`, { method: "POST", cookie: deskCookie }), idParams(json.link.id));
      expect(res.status).toBe(200);
      expect((await res.json()).link.status).toBe("revoked");
      const again = await revokeRoute(request(`/api/intake/links/${json.link.id}/revoke`, { method: "POST", cookie: deskCookie }), idParams(json.link.id));
      expect(again.status).toBe(200);
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "intake.link.revoke", entityId: json.link.id } })).toBe(1);
      await expectDead(token);
    });

    it("a used-up link", async () => {
      const { token } = await createLink({ kind: "OPEN", maxUses: 1 });
      expect((await publicPost(token, form({ fullName: "Only One", phone: "01222222222" }))).res.status).toBe(200);
      await expectDead(token);
    });

    it("a single-use link taken by two people at once lets exactly one through", async () => {
      const { token } = await createLink({ kind: "OPEN", maxUses: 1 });
      const results = await Promise.all([
        publicPost(token, form({ fullName: "Race One", phone: "01233333331" })),
        publicPost(token, form({ fullName: "Race Two", phone: "01233333332" })),
      ]);
      expect(results.map((r) => r.res.status).sort()).toEqual([200, 404]);
    });

    it("another clinic's token on a clinic's own domain", async () => {
      const { json } = await linksCreateRoute(request("/api/intake/links", { method: "POST", cookie: ownerBCookie, body: { kind: "OPEN" } })).then(async (res) => ({ json: await res.json() }));
      const tokenB = (json.url as string).split("/onboard/")[1]!;
      // On tenant A's subdomain, B's token does not exist.
      await expectDead(tokenB, { "x-forwarded-host": `${a.slug}.lvh.me:3000` });
      // On B's own subdomain and on the canonical host the link is shared on, it works.
      expect((await publicGet(tokenB, { "x-forwarded-host": `${b.slug}.lvh.me:3000` })).res.status).toBe(200);
      expect((await publicGet(tokenB)).res.status).toBe(200);
      // A's token on A's subdomain works too.
      expect((await publicGet(deskLink.token, { "x-forwarded-host": `${a.slug}.lvh.me:3000` })).res.status).toBe(200);
    });

    it("a patient link pointing at another clinic's patient, and a suspended clinic", async () => {
      const crossed = issueIntakeToken();
      await db.intakeLink.create({
        data: { tenantId: a.id, kind: "PATIENT", patientId: patientB, tokenHash: crossed.tokenHash, tokenPrefix: crossed.tokenPrefix, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await expectDead(crossed.token);

      const suspended = await createTenant({ slug: `intake-s-${Date.now().toString(36)}`, status: "SUSPENDED" });
      created.push(suspended.id);
      const t = issueIntakeToken();
      await db.intakeLink.create({ data: { tenantId: suspended.id, kind: "OPEN", tokenHash: t.tokenHash, tokenPrefix: t.tokenPrefix, expiresAt: new Date(Date.now() + 86_400_000) } });
      await expectDead(t.token);
    });

    it("an archived patient's personal link", async () => {
      const temp = await db.patient.create({ data: { tenantId: a.id, fullName: "Archived Soon" } });
      const { token } = await createLink({ kind: "PATIENT", patientId: temp.id });
      expect((await publicGet(token)).res.status).toBe(200);
      await db.patient.update({ where: { id: temp.id }, data: { deletedAt: new Date() } });
      await expectDead(token);
    });
  });

  describe("review queue", () => {
    it("lists pending forms oldest first, with the phone-match suggestion", async () => {
      const res = await submissionsRoute(request("/api/intake/submissions", { cookie: deskCookie }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.counts.PENDING).toBe(json.total);
      const names = json.submissions.map((s: { fullName: string }) => s.fullName);
      expect(names.indexOf("Nour Hassan")).toBeLessThan(names.indexOf("سلمى فؤاد"));
      const salmaForm = json.submissions.find((s: { fullName: string }) => s.fullName === "سلمى فؤاد");
      expect(salmaForm).toMatchObject({ language: "ar", matchedPatient: { id: salma, fullName: "Salma Fouad", phone: "+201055556666" }, link: { kind: "OPEN", label: "Reception desk QR" } });
    });

    it("accepts a form as a new patient: profile, history, medications, INTAKE timeline event, audit", async () => {
      const s = await submissionFor("Nour Hassan");
      const { res, json } = await accept(s.id, { mode: "create" });
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ created: true, submission: { id: s.id, status: "ACCEPTED", reviewedBy: { id: desk.id } } });
      const p = await db.patient.findUniqueOrThrow({ where: { id: json.patientId }, include: { medicalHistory: true, medications: true } });
      expect(p).toMatchObject({
        tenantId: a.id,
        fullName: "Nour Hassan",
        gender: "FEMALE",
        phone: "+201017778888",
        whatsapp: "+201017778888",
        email: "nour@example.test",
        city: "Maadi",
        nationalId: "29204110101234",
        address: "Road 9, Maadi",
        emergencyContact: "Ali Hassan · +201229998877 (Father)",
        language: "en",
        tags: ["acne"],
        source: "WEBSITE",
      });
      expect(p.dateOfBirth?.toISOString()).toBe("1992-04-11T00:00:00.000Z");
      expect(p.notes).toBe("Onboarding form: Breakouts on the jawline (since One year)");
      expect(p.medicalHistory).toMatchObject({ chronicConditions: ["Asthma"], allergies: ["Sulfa drugs"], surgeries: [], diagnoses: [] });
      expect(p.medications.map((m) => [m.name, m.dosage, m.active])).toEqual([["Ventolin", "2 puffs as needed", true]]);

      const events = await db.timelineEvent.findMany({ where: { tenantId: a.id, patientId: p.id, kind: "INTAKE" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ title: "Onboarding form received", refId: s.id });
      expect(events[0]!.body).toContain("Submitted via open link (Reception desk QR) in English.");
      expect(events[0]!.body).toContain("Interested in: Acne treatment.");

      const row = await db.intakeSubmission.findUniqueOrThrow({ where: { id: s.id } });
      expect(row).toMatchObject({ status: "ACCEPTED", patientId: p.id, reviewedById: desk.id });
      const actions = (await db.auditLog.findMany({ where: { tenantId: a.id, OR: [{ entityId: s.id }, { entityId: p.id }] } })).map((x) => x.action);
      expect(actions).toEqual(expect.arrayContaining(["intake.submission.create", "intake.submission.accept", "patient.create"]));
    });

    it("refuses to review the same form twice (409), even when two people press Accept at once", async () => {
      const s = await submissionFor("Nour Hassan");
      const again = await accept(s.id, { mode: "create" });
      expect(again.res.status).toBe(409);
      expect(again.json.error).toBe("not_pending");

      const racer = await submissionFor("Same Time One");
      const results = await Promise.all([accept(racer.id, { mode: "create" }), accept(racer.id, { mode: "create" })]);
      expect(results.map((r) => r.res.status).sort()).toEqual([200, 409]);
      expect(await db.patient.count({ where: { tenantId: a.id, fullName: "Same Time One" } })).toBe(1);
    });

    it("merges into the phone-matched patient: fills empty fields only, appends history without duplicates", async () => {
      const s = await submissionFor("سلمى فؤاد");
      const { res, json } = await accept(s.id, { mode: "merge" });
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ created: false, patientId: salma });
      const p = await db.patient.findUniqueOrThrow({ where: { id: salma }, include: { medicalHistory: true, medications: { orderBy: { createdAt: "asc" } } } });
      // Kept: the name and the e-mail already on file. Filled: what was empty.
      expect(p).toMatchObject({ fullName: "Salma Fouad", email: "salma@old.test", city: "الجيزة", nationalId: "29001010101010", tags: ["vip", "pigmentation"] });
      expect(p.dateOfBirth?.toISOString()).toBe("1990-01-01T00:00:00.000Z");
      expect(p.medicalHistory).toMatchObject({ chronicConditions: ["Hypothyroidism", "Asthma"], allergies: ["Penicillin", "Latex"], surgeries: ["Appendectomy"] });
      expect(p.medications.map((m) => m.name)).toEqual(["Levothyroxine", "Ventolin"]);
      const events = await db.timelineEvent.findMany({ where: { tenantId: a.id, patientId: salma, kind: "INTAKE" } });
      expect(events.map((e) => e.refId)).toEqual([s.id]);
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a.id, action: "patient.update", entityId: salma } });
      expect(audit.after).toMatchObject({ city: "الجيزة", medicationsAdded: ["Ventolin"], via: "intake", submissionId: s.id });
    });

    it("merges into a patient chosen by hand, but never into another tenant's", async () => {
      const s = await submissionFor("Same Time Two");
      const foreign = await accept(s.id, { mode: "merge", patientId: patientB });
      expect(foreign.res.status).toBe(404);
      expect((await db.intakeSubmission.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
      const noTarget = await accept(s.id, { mode: "merge" });
      expect(noTarget.res.status).toBe(422);
      const ok = await accept(s.id, { mode: "merge", patientId: salma });
      expect(ok.res.status).toBe(200);
      expect(ok.json.patientId).toBe(salma);
      expect((await accept(s.id, { mode: "bogus" })).res.status).toBe(422);
    });

    it("rejects a form with a reason; nothing is written to any patient", async () => {
      const s = await submissionFor("Same Time Three");
      const patientsBefore = await db.patient.count({ where: { tenantId: a.id } });
      expect((await reject(s.id, { note: "  " })).res.status).toBe(422);
      const { res, json } = await reject(s.id, { note: "Duplicate test entry" });
      expect(res.status).toBe(200);
      expect(json.submission).toMatchObject({ status: "REJECTED", reviewNote: "Duplicate test entry", reviewedBy: { id: desk.id } });
      expect((await reject(s.id, { note: "Again" })).res.status).toBe(409);
      expect((await accept(s.id, { mode: "create" })).res.status).toBe(409);
      expect(await db.patient.count({ where: { tenantId: a.id } })).toBe(patientsBefore);
      expect(await db.auditLog.count({ where: { tenantId: a.id, action: "intake.submission.reject", entityId: s.id } })).toBe(1);
    });
  });

  describe("access", () => {
    it("an assistant (read-only) gets 403 on every staff intake route", async () => {
      const s = await submissionFor("Only One");
      expect((await submissionsRoute(request("/api/intake/submissions", { cookie: assistantCookie }))).status).toBe(403);
      expect((await linksListRoute(request("/api/intake/links", { cookie: assistantCookie }))).status).toBe(403);
      expect((await createLink({ kind: "OPEN" }, assistantCookie)).res.status).toBe(403);
      expect((await accept(s.id, { mode: "create" }, assistantCookie)).res.status).toBe(403);
      expect((await reject(s.id, { note: "no" }, assistantCookie)).res.status).toBe(403);
      const revoke = await revokeRoute(request(`/api/intake/links/${deskLink.id}/revoke`, { method: "POST", cookie: assistantCookie }), idParams(deskLink.id));
      expect(revoke.status).toBe(403);
      expect((await db.intakeSubmission.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    });

    it("tenant B cannot see, accept, reject or revoke tenant A's forms and links", async () => {
      const s = await submissionFor("Only One");
      const list = await (await submissionsRoute(request("/api/intake/submissions?status=all", { cookie: ownerBCookie }))).json();
      expect(list.submissions.map((x: { id: string }) => x.id)).not.toContain(s.id);
      expect(list.counts).toEqual({ PENDING: 0, ACCEPTED: 0, REJECTED: 0 });
      expect((await accept(s.id, { mode: "create" }, ownerBCookie)).res.status).toBe(404);
      expect((await reject(s.id, { note: "not yours" }, ownerBCookie)).res.status).toBe(404);
      const revoke = await revokeRoute(request(`/api/intake/links/${deskLink.id}/revoke`, { method: "POST", cookie: ownerBCookie }), idParams(deskLink.id));
      expect(revoke.status).toBe(404);
      expect((await db.intakeLink.findUniqueOrThrow({ where: { id: deskLink.id } })).revokedAt).toBeNull();
      expect((await db.intakeSubmission.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    });

    it("staff routes need a session and refuse cross-origin writes", async () => {
      expect((await submissionsRoute(request("/api/intake/submissions"))).status).toBe(401);
      const cross = await linksCreateRoute(request("/api/intake/links", { method: "POST", cookie: deskCookie, body: { kind: "OPEN" }, headers: { origin: "https://evil.example" } }));
      expect(cross.status).toBe(403);
    });
  });
});
