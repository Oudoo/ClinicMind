import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { parsePatientListQuery } from "@/modules/patients/filters";
import { createPatient, listOptionsFromQuery, listPatients } from "@/modules/patients/service";

export const dynamic = "force-dynamic";

/**
 * Paginated patient registry of the acting tenant.
 *
 * Query: `q` (name / phone / national id / e-mail, Arabic digits accepted),
 * `gender`, `age` (u18 | 18-30 | 31-45 | 46-60 | 60p), `tag`, `doctor`,
 * `upcoming` (yes | no | week), `visit` (30 | 90 | 180 | over180 | never),
 * `reg` (week | month | quarter | custom with `from` / `to`), `lang`, `source`,
 * `archived` (1 = include, only), `sort` (newest | oldest | name_asc |
 * name_desc | last_visit | next_appointment | age_desc | age_asc), `page`,
 * `pageSize`. Unknown values are ignored. Responds `{ patients, total, page,
 * pageSize }`; each patient carries `lastVisitAt`, `nextAppointmentAt`,
 * `upcomingCount` and `exact` (the search matched a phone / id exactly).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");

    const params = new URL(req.url).searchParams;
    const { page, pageSize } = parsePaging(params);
    const query = parsePatientListQuery(params);
    const timezone = await getTenantTimezone(ctx.tenantId);
    const result = await listPatients(ctx.tenantId, {
      ...listOptionsFromQuery(query, timezone),
      page,
      pageSize,
    });
    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

/** Register a patient. Responds 201 `{ patient }`, or 422 with field errors. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const patient = await createPatient(ctx.tenantId, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ patient }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
