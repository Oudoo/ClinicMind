import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { createPatient, listPatients, PatientInput } from "@/modules/patients/service";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    const q = new URL(req.url).searchParams.get("q") ?? undefined;
    return ok({ patients: await listPatients(ctx.tenantId, q) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");
    const input = PatientInput.parse(await req.json());
    const patient = await createPatient(ctx.tenantId, input, {
      id: ctx.userId ?? undefined,
      email: ctx.email ?? undefined,
    });
    return ok({ patient }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
