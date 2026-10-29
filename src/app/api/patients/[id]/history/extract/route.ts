import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { extractHistory } from "@/lib/ai/history-extraction";
import { deidentifyForPatient } from "@/lib/ai/identities";
import { resolveTenantAi } from "@/lib/ai/tenant-config";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ text: z.string().trim().min(10).max(20_000) });

/**
 * Turn a dictated or typed background note into suggested medical-history
 * lists for the editor. Nothing is saved here: the clinician reviews the
 * suggestions in the form and saves with PATCH /history.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const { text } = Body.parse(await req.json());
    const patient = await db.patient.findFirst({ where: { id, tenantId: ctx.tenantId, ...notDeleted }, select: { id: true } });
    if (!patient) return notFound("patient");

    const tenantAi = await resolveTenantAi(ctx.tenantId);
    // The note leaves the clinic without the patient's name, numbers or e-mail.
    const sent = await deidentifyForPatient(ctx.tenantId, patient.id, text);
    const result = await extractHistory(sent, { tenantAi });

    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "history_extraction",
          provider: result.provider,
          model: result.model,
          rawPrompt: sent.slice(0, 4000),
          generatedOutput: result.raw,
          status: "SUCCEEDED",
          latencyMs: result.latencyMs,
          error: result.empty ? "no_structured_data" : null,
        },
      })
      .catch(() => undefined);

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      ip: clientIp(req),
      action: "patient.history.extract",
      entity: "Patient",
      entityId: patient.id,
      after: { provider: result.provider, model: result.model, empty: result.empty, characters: text.length },
    });

    return ok({ suggestions: result.data, empty: result.empty, provider: result.provider, model: result.model });
  } catch (err) {
    return handleApiError(err);
  }
}
