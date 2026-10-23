import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { transcriptionProvider } from "@/lib/ai/provider";
import { resolveTenantAi } from "@/lib/ai/tenant-config";
import { MAX_AUDIO_BYTES, normaliseAudioType } from "@/lib/ai/transcription";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { NextResponse } from "next/server";
import type { TranscribeResponse } from "@/modules/consultations/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const Fields = z.object({
  /** Which record the dictation is for; checked against the tenant, used for the audit trail only. */
  patientId: z.string().trim().min(1).max(64).optional(),
  language: z.enum(["auto", "ar", "en"]).default("auto"),
  /** `ambient` labels doctor/patient turns and requires the consent flag. */
  mode: z.enum(["dictation", "ambient"]).default("dictation"),
  consent: z.enum(["true", "false"]).optional(),
});

/**
 * Speech-to-text for the consultation and history editors. Accepts a browser
 * recording (multipart `audio`), returns the transcript and nothing else is
 * stored: the audio is discarded after the call, the transcript is logged as an
 * AI run (first 4,000 characters) and lands in the record only when the
 * clinician extracts, reviews and signs. 503 when no provider can transcribe.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const form = await req.formData().catch(() => null);
    if (!form) return bad("invalid_body", "Send the audio as multipart form data.");
    const fields = Fields.safeParse({
      patientId: str(form.get("patientId")),
      language: str(form.get("language")) ?? "auto",
      mode: str(form.get("mode")) ?? "dictation",
      consent: str(form.get("consent")),
    });
    if (!fields.success) return bad("validation_error", "Invalid dictation options.");
    const { patientId, language, mode, consent } = fields.data;
    if (mode === "ambient" && consent !== "true") return bad("consent_required", "Confirm the patient's consent before recording a consultation.");

    const file = form.get("audio");
    if (!(file instanceof Blob)) return bad("audio_required", "Attach the recording as the `audio` field.");
    const mimeType = normaliseAudioType(file.type);
    if (!mimeType) return new NextResponse(JSON.stringify({ error: "unsupported_audio", message: `Unsupported audio type ${file.type || "(unknown)"}.` }), { status: 415, headers: json });
    if (file.size === 0) return bad("audio_required", "The recording is empty.");
    if (file.size > MAX_AUDIO_BYTES) return new NextResponse(JSON.stringify({ error: "audio_too_large", message: "Recordings are limited to 15 MB; stop and transcribe in shorter parts." }), { status: 413, headers: json });

    if (patientId) await requireTenantPatient(ctx.tenantId, patientId);

    const tenantAi = await resolveTenantAi(ctx.tenantId);
    const provider = transcriptionProvider(undefined, tenantAi);
    if (!provider) {
      return new NextResponse(
        JSON.stringify({ error: "transcription_unavailable", message: "No speech-to-text provider is configured for this clinic. Type or paste the transcript instead." }),
        { status: 503, headers: json },
      );
    }

    const audio = new Uint8Array(await file.arrayBuffer());
    const started = Date.now();
    let result;
    try {
      result = await provider.transcribe(audio, { mimeType, language, speakers: mode === "ambient" });
    } catch (err) {
      await db.aiRun
        .create({
          data: {
            tenantId: ctx.tenantId,
            authorId: ctx.userId,
            kind: "transcription",
            provider: provider.name,
            model: provider.transcriptionModel() ?? "",
            rawPrompt: `${mode} · ${mimeType} · ${file.size} bytes · ${language}`,
            status: "FAILED",
            latencyMs: Date.now() - started,
            error: err instanceof Error ? err.message.slice(0, 500) : "transcription failed",
          },
        })
        .catch(() => undefined);
      throw err;
    }

    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "transcription",
          provider: result.provider,
          model: result.model,
          rawPrompt: `${mode} · ${mimeType} · ${file.size} bytes · ${language}`,
          generatedOutput: result.text.slice(0, 4000),
          status: "SUCCEEDED",
          latencyMs: result.latencyMs,
          error: result.text ? null : "no_speech",
        },
      })
      .catch(() => undefined);

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "consultation.transcribe",
      entity: patientId ? "Patient" : "Consultation",
      entityId: patientId ?? "dictation",
      after: { mode, language, mimeType, bytes: file.size, consent: mode === "ambient", provider: result.provider, model: result.model, characters: result.text.length },
    });

    const response: TranscribeResponse = {
      transcript: result.text,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      empty: result.text.length === 0,
    };
    return ok(response);
  } catch (err) {
    return handleApiError(err);
  }
}

const json = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const str = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const bad = (error: string, message: string) => new NextResponse(JSON.stringify({ error, message }), { status: 422, headers: json });
