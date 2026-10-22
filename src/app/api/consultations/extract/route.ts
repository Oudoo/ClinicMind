import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { extractClinicalData } from "@/lib/ai/extraction";
import { chatProvider } from "@/lib/ai/provider";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { ok, unauthorized } from "@/lib/api";
import { handleConsultationError, requireTenantAppointmentOfPatient } from "@/modules/consultations/service";
import { TRANSCRIPT_MAX_LENGTH, TRANSCRIPT_MIN_LENGTH, type ExtractResponse } from "@/modules/consultations/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const zId = z.string().trim().min(1).max(64);

const Body = z.object({
  patientId: zId,
  transcript: z.string().trim().min(TRANSCRIPT_MIN_LENGTH).max(TRANSCRIPT_MAX_LENGTH),
  /** Validated against the tenant and the patient, then handed back for the sign step. */
  appointmentId: zId.optional(),
});

/**
 * Run extraction on a transcript and persist a PENDING_REVIEW consultation.
 * Nothing is written to the patient's clinical record until a clinician signs.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const { patientId, transcript, appointmentId } = Body.parse(await req.json());

    // The patient (and the appointment, which must be this patient's) must
    // belong to the acting tenant (SEC-4). Checked before any model call so a
    // foreign id costs nothing and leaks nothing.
    await requireTenantPatient(ctx.tenantId, patientId);
    if (appointmentId) await requireTenantAppointmentOfPatient(ctx.tenantId, patientId, appointmentId);

    const [extraction, summary] = await Promise.all([extractClinicalData(transcript), summarize(transcript)]);
    const empty = Boolean(extraction.empty);

    const consultation = await db.consultation.create({
      data: {
        tenantId: ctx.tenantId,
        patientId,
        doctorId: ctx.userId,
        status: "PENDING_REVIEW",
        transcript,
        extraction: JSON.parse(JSON.stringify(extraction.data)) as Prisma.InputJsonValue,
        summary: summary || null,
      },
      select: { id: true },
    });

    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "extraction",
          provider: extraction.provider,
          model: extraction.model,
          rawPrompt: transcript.slice(0, 4000),
          generatedOutput: extraction.raw,
          status: "SUCCEEDED",
          latencyMs: extraction.latencyMs,
          error: empty ? "no_structured_data" : null,
        },
      })
      .catch(() => undefined);

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "consultation.extract",
      entity: "Consultation",
      entityId: consultation.id,
      after: {
        status: "PENDING_REVIEW",
        patientId,
        appointmentId: appointmentId ?? null,
        provider: extraction.provider,
        model: extraction.model,
        empty,
        transcriptLength: transcript.length,
      },
    });

    const response: ExtractResponse = {
      consultationId: consultation.id,
      extraction: extraction.data,
      summary,
      empty,
      appointmentId: appointmentId ?? null,
      provider: extraction.provider,
      model: extraction.model,
    };
    return ok(response);
  } catch (err) {
    return handleConsultationError(err);
  }
}

async function summarize(transcript: string): Promise<string> {
  try {
    const res = await chatProvider().chat(
      [
        {
          role: "system",
          content:
            "Summarize this consultation in 3-4 concise clinical sentences for the visit record. Use only facts stated in the transcript; do not add assessments, diagnoses or plans that were not stated. Plain text, no headings or lists.",
        },
        { role: "user", content: transcript },
      ],
      { temperature: 0.2, maxTokens: 300 },
    );
    // The offline echo provider has no model behind it; its canned reply must
    // never be offered as a clinical summary. The clinician writes one instead.
    if (res.provider === "echo") return "";
    return res.content.trim();
  } catch {
    return "";
  }
}
