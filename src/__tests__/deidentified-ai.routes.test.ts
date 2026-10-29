/**
 * Patient data protection for AI calls (Phase 4): every text that reaches an
 * AI provider (the chat model and the embedding model) is captured here and
 * checked for the patient's name, phone, national ID and e-mail, on every
 * path that calls one: indexing a record, the assistant's answer, the
 * consultation extraction and summary, and the history extraction. The
 * clinic's own record keeps everything; the answers come back with the names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiMessage, AiProvider, ChatOptions, EmbedOptions } from "@/lib/ai/types";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { answerWithRag } from "@/lib/ai/rag";
import { ingestPatient } from "@/modules/knowledge/ingest";
import { POST as extract } from "@/app/api/consultations/extract/route";
import { POST as extractHistory } from "@/app/api/patients/[id]/history/extract/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

const sent = vi.hoisted(() => ({ chat: [] as string[], embed: [] as string[] }));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  // Everything handed to a provider, recorded on its way out.
  const watch = (provider: AiProvider): AiProvider =>
    new Proxy(provider, {
      get(target, prop) {
        if (prop === "chat")
          return (messages: AiMessage[], opts?: ChatOptions) => {
            sent.chat.push(messages.map((m) => m.content).join("\n"));
            return target.chat(messages, opts);
          };
        if (prop === "embed")
          return (texts: string[], opts?: EmbedOptions) => {
            sent.embed.push(...texts);
            return target.embed(texts, opts);
          };
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  return {
    ...actual,
    chatProvider: (...args: Parameters<typeof actual.chatProvider>) => watch(actual.chatProvider(...args)),
    embeddingProvider: (...args: Parameters<typeof actual.embeddingProvider>) => watch(actual.embeddingProvider(...args)),
  };
});

runAsSystem();

const IDENTIFIERS = ["Mervat", "Adel", "1234567", "29801011234567", "mervat.adel@example.com"];
const expectNoIdentifiers = (texts: string[]) => {
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) for (const id of IDENTIFIERS) expect(text, `"${id}" left the clinic`).not.toContain(id);
};

describe.skipIf(!dbTestsEnabled)("what reaches an AI provider", () => {
  const created: string[] = [];
  let tenantId: string;
  let patientId: string;
  let doctorCookie: string;

  beforeAll(async () => {
    const tenant = await createTenant({ slug: `deid-${Date.now().toString(36)}` });
    tenantId = tenant.id;
    created.push(tenantId);
    // A doctor whose surname is also the patient's: staff names stay as they are.
    const doctor = await createUser({ tenantId, role: "DOCTOR", fullName: "Dr. Omar Hassan" });
    doctorCookie = await sessionCookieFor(doctor.id);
    patientId = (
      await db.patient.create({
        data: {
          tenantId,
          fullName: "Mervat Adel Hassan",
          gender: "FEMALE",
          dateOfBirth: new Date("1999-04-12T00:00:00Z"),
          phone: "+201001234567",
          nationalId: "29801011234567",
          email: "mervat.adel@example.com",
          notes: "Prefers calls on 01001234567 or mervat.adel@example.com.",
          medicalHistory: { create: { tenantId, allergies: ["Penicillin"], chronicConditions: ["Acne vulgaris"], diagnoses: ["Nodular acne"] } },
          medications: { create: { tenantId, name: "Doxycycline", dosage: "100 mg", frequency: "Once daily", active: true } },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("indexing a record embeds it without the patient's name, numbers or e-mail; the store keeps it whole", async () => {
    sent.embed.length = 0;
    await ingestPatient(tenantId, patientId);
    expectNoIdentifiers(sent.embed);
    expect(sent.embed.join("\n")).toContain("Patient: the patient");
    const stored = await db.knowledgeEmbedding.findMany({ where: { tenantId, patientId }, select: { content: true, metadata: true } });
    expect(stored.some((c) => c.content.includes("Mervat Adel Hassan"))).toBe(true);
    expect(stored.every((c) => (c.metadata as { deidentified?: boolean }).deidentified === true)).toBe(true);
  });

  it("the assistant sends labels, not names, and its answer comes back with the name", async () => {
    sent.chat.length = 0;
    sent.embed.length = 0;
    const answer = await answerWithRag(tenantId, "Which allergies does Mervat Adel Hassan have, and what is she taking?", { people: [{ id: patientId, fullName: "Mervat Adel Hassan" }] });
    expectNoIdentifiers([...sent.chat, ...sent.embed]);
    expect(sent.chat.join("\n")).toContain("patient: Patient A");
    expect(sent.chat.join("\n")).toContain("Patients are named by labels");
    expect(answer.answer).toContain("Mervat Adel Hassan");
    expect(answer.answer).not.toContain("Patient A");
    expect(answer.citations.some((c) => c.patientId === patientId && c.patientName === "Mervat Adel Hassan")).toBe(true);
  });

  it("the consultation extraction and summary get the transcript without the patient's name or numbers; the record keeps it", async () => {
    sent.chat.length = 0;
    const transcript = "Doctor: Good morning Mervat. Is your phone still 01001234567?\nPatient: Yes. The acne is worse on the doxycycline.\nDoctor: Dr. Omar Hassan will start isotretinoin 20 mg daily after a pregnancy test.";
    const res = await extract(request("/api/consultations/extract", { cookie: doctorCookie, body: { patientId, transcript } }));
    expect(res.status).toBe(200);
    expectNoIdentifiers(sent.chat);
    expect(sent.chat.join("\n")).toContain("Good morning the patient");
    expect(sent.chat.join("\n")).toContain("Dr. Omar Hassan");
    const { consultationId } = (await res.json()) as { consultationId: string };
    expect((await db.consultation.findUniqueOrThrow({ where: { id: consultationId } })).transcript).toBe(transcript);
    const run = await db.aiRun.findFirstOrThrow({ where: { tenantId, kind: "extraction" }, orderBy: { createdAt: "desc" } });
    expectNoIdentifiers([run.rawPrompt]);
  });

  it("the history extraction gets the note without the patient's name, numbers or e-mail", async () => {
    sent.chat.length = 0;
    const res = await extractHistory(
      request(`/api/patients/${patientId}/history/extract`, { cookie: doctorCookie, body: { text: "Mervat Adel has had hypothyroidism since 2019 and is allergic to sulfa. Reach her on 01001234567 or mervat.adel@example.com." } }),
      { params: Promise.resolve({ id: patientId }) },
    );
    expect(res.status).toBe(200);
    expectNoIdentifiers(sent.chat);
    expect(sent.chat.join("\n")).toContain("hypothyroidism since 2019");
  });
});
