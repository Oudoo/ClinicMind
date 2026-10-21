import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import {
  createAppointment,
  listAppointments,
  AppointmentInput,
} from "@/modules/appointments/service";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const params = new URL(req.url).searchParams;
    const from = params.get("from") ? new Date(params.get("from")!) : new Date();
    const to = params.get("to")
      ? new Date(params.get("to")!)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return ok({ appointments: await listAppointments(ctx.tenantId, { from, to }) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const input = AppointmentInput.parse(await req.json());
    const result = await createAppointment(ctx.tenantId, input, {
      id: ctx.userId ?? undefined,
      email: ctx.email ?? undefined,
    });
    return ok(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
