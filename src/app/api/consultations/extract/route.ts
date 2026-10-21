import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { extractClinicalData } from "@/lib/ai/extraction";
import { chatProvider } from "@/lib/ai/provider";
import { db } from "@/lib/db";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ patientId: z.string(), transcript: z.string().min(1) });

/**
 * Run extraction on a transcript and persist a PENDING_REVIEW consultation.
 * Nothing is written to the patient's clinical record until a clinician signs.
 */
export async function POST(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const { patientId, transcript } = Body.parse(await req.json());

    const [{ data, provider, model }, summary] = await Promise.all([
      extractClinicalData(transcript),
      summarize(transcript),
    ]);

    const consultation = await db.consultation.create({
      data: {
        tenantId: ctx.tenantId,
        patientId,
        doctorId: ctx.userId,
        status: "PENDING_REVIEW",
        transcript,
        extraction: data as never,
        summary,
      },
    });

    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "extraction",
          provider,
          model,
          rawPrompt: transcript.slice(0, 4000),
          generatedOutput: JSON.stringify(data),
          status: "SUCCEEDED",
        },
      })
      .catch(() => undefined);

    return ok({ consultationId: consultation.id, extraction: data, summary });
  } catch (err) {
    return handleApiError(err);
  }
}

async function summarize(transcript: string): Promise<string> {
  try {
    const res = await chatProvider().chat(
      [
        { role: "system", content: "Summarize this consultation in 3-4 concise clinical sentences. Only use facts from the transcript." },
        { role: "user", content: transcript },
      ],
      { temperature: 0.2, maxTokens: 300 },
    );
    return res.content;
  } catch {
    return "";
  }
}
