/**
 * POST /api/consultations/transcribe without any speech-to-text provider (the
 * test environment has no vendor keys): validation and the honest 503.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as transcribe } from "@/app/api/consultations/transcribe/route";
import { MAX_AUDIO_BYTES } from "@/lib/ai/transcription";
import { createTenant, createUser, deleteTenants, sessionCookieFor } from "@/test/db";
import { audioRequest } from "@/test/audio";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.skipIf(!hasDb)("POST /api/consultations/transcribe (no provider)", () => {
  const created: string[] = [];
  let nurseCookie: string;
  let assistantCookie: string;

  beforeAll(async () => {
    const tenant = await createTenant({ slug: `stt-${Date.now().toString(36)}` });
    created.push(tenant.id);
    nurseCookie = await sessionCookieFor((await createUser({ tenantId: tenant.id, role: "NURSE" })).id);
    assistantCookie = await sessionCookieFor((await createUser({ tenantId: tenant.id, role: "ASSISTANT" })).id);
  });
  afterAll(async () => deleteTenants(created));

  it("needs a session and the consultations:read permission", async () => {
    expect((await transcribe(audioRequest(null, {}, { bytes: 10, type: "audio/webm" }))).status).toBe(401);
    expect((await transcribe(audioRequest(assistantCookie, {}, { bytes: 10, type: "audio/webm" }))).status).toBe(403);
  });

  it("validates the upload before touching any provider", async () => {
    const missing = await transcribe(audioRequest(nurseCookie, {}));
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toBe("audio_required");

    const wrongType = await transcribe(audioRequest(nurseCookie, {}, { bytes: 10, type: "text/plain" }));
    expect(wrongType.status).toBe(415);

    const tooBig = await transcribe(audioRequest(nurseCookie, {}, { bytes: MAX_AUDIO_BYTES + 1, type: "audio/webm" }));
    expect(tooBig.status).toBe(413);

    const noConsent = await transcribe(audioRequest(nurseCookie, { mode: "ambient" }, { bytes: 10, type: "audio/webm" }));
    expect(noConsent.status).toBe(422);
    expect((await noConsent.json()).error).toBe("consent_required");
  });

  it("answers 503 instead of inventing a transcript when nothing can transcribe", async () => {
    const res = await transcribe(audioRequest(nurseCookie, { language: "ar" }, { bytes: 2048, type: "audio/webm;codecs=opus" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("transcription_unavailable");
  });
});
