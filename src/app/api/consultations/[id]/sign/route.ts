import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  summary: z.string().optional(),
  extraction: z
    .object({
      symptoms: z.array(z.string()).default([]),
      diagnoses: z.array(z.string()).default([]),
      medications: z
        .array(z.object({ name: z.string(), dosage: z.string().optional(), frequency: z.string().optional() }))
        .default([]),
      tests: z.array(z.string()).default([]),
      followUps: z.array(z.string()).default([]),
    })
    .optional(),
});

/**
 * Sign a reviewed consultation. ONLY clinicians (consultations:sign) may do this.
 * On signing we create the immutable Visit, append to the patient's medical
 * history and medications, and emit timeline events. The consultation row's prior
 * state is preserved in the audit log.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:sign");

    const body = Body.parse(await req.json());

    const consultation = await db.consultation.findFirst({
      where: { id: params.id, tenantId: ctx.tenantId },
    });
    if (!consultation) return ok({ error: "not_found" }, { status: 404 });

    const extraction = body.extraction ?? (consultation.extraction as never) ?? {};
    const summary = body.summary ?? consultation.summary ?? "";

    const result = await db.$transaction(async (tx) => {
      const visit = await tx.visit.create({
        data: {
          tenantId: ctx.tenantId,
          patientId: consultation.patientId,
          doctorId: ctx.userId,
          transcript: consultation.transcript,
          summary,
          notes: summary,
        },
      });

      await tx.consultation.update({
        where: { id: consultation.id },
        data: {
          status: "SIGNED",
          visitId: visit.id,
          extraction: extraction as never,
          summary,
          reviewedById: ctx.userId,
          reviewedAt: new Date(),
        },
      });

      // Append diagnoses to medical history (never overwrite).
      const diagnoses = (extraction as { diagnoses?: string[] }).diagnoses ?? [];
      if (diagnoses.length) {
        const history = await tx.medicalHistory.findUnique({
          where: { patientId: consultation.patientId },
        });
        const existing = Array.isArray(history?.diagnoses) ? (history!.diagnoses as string[]) : [];
        await tx.medicalHistory.upsert({
          where: { patientId: consultation.patientId },
          create: { patientId: consultation.patientId, diagnoses: diagnoses as never },
          update: { diagnoses: [...existing, ...diagnoses] as never },
        });
      }

      // Persist new medications.
      const meds = (extraction as { medications?: { name: string; dosage?: string; frequency?: string }[] }).medications ?? [];
      for (const m of meds) {
        await tx.medication.create({
          data: {
            patientId: consultation.patientId,
            name: m.name,
            dosage: m.dosage,
            frequency: m.frequency,
            startDate: new Date(),
          },
        });
      }

      await tx.timelineEvent.create({
        data: {
          tenantId: ctx.tenantId,
          patientId: consultation.patientId,
          kind: "VISIT",
          title: "Consultation signed",
          body: summary,
          refId: visit.id,
          occurredAt: new Date(),
        },
      });

      return visit;
    });

    await audit({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorEmail: ctx.email,
      action: "consultation.sign",
      entity: "Consultation",
      entityId: consultation.id,
      before: { status: consultation.status },
      after: { status: "SIGNED", visitId: result.id },
    });

    return ok({ ok: true, visitId: result.id });
  } catch (err) {
    return handleApiError(err);
  }
}
