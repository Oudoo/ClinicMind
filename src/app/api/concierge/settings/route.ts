import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { onCallNow } from "@/modules/concierge/service";
import { listRosterCandidates, readConciergeSettings, resolveRoster, updateConciergeSettings } from "@/modules/concierge/settings";
import { conciergeContext, jsonBody } from "../_lib/context";
import { conciergeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

async function view(tenantId: string) {
  const settings = await readConciergeSettings(tenantId);
  const [candidates, roster, onCall] = await Promise.all([listRosterCandidates(tenantId), resolveRoster(tenantId, settings), onCallNow(tenantId)]);
  return {
    settings,
    candidates,
    // Who each slot resolves to today (a saved person, or the default by role).
    effective: {
      inHours: roster.inHours ? { id: roster.inHours.id, fullName: roster.inHours.fullName, isDefault: roster.defaults.inHours } : null,
      outOfHours: roster.outOfHours ? { id: roster.outOfHours.id, fullName: roster.outOfHours.fullName, isDefault: roster.defaults.outOfHours } : null,
      backup: roster.backup ? { id: roster.backup.id, fullName: roster.backup.fullName, isDefault: roster.defaults.backup } : null,
    },
    onCall,
  };
}

/** `GET /api/concierge/settings` → `{ settings, candidates, effective, onCall }`: hours, the roster, the acknowledgement targets and who is on call now. */
export async function GET(req: Request) {
  try {
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    return ok(await view(c.ctx.tenantId));
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `PUT /api/concierge/settings` with `{ hours: { days[0–6], start, end },
 * roster: { inHoursUserId, outOfHoursUserId, backupUserId }, ackMinutes:
 * { inHours, outOfHours } }` (owner only, `tenant:manage`). Roster ids must be
 * active owners, doctors or nurses of the clinic (404 for a foreign id, 422
 * for someone who cannot act on a reply). → the same shape as GET.
 */
export async function PUT(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "tenant:manage");
    if (!c) return unauthorized();
    await updateConciergeSettings(c.ctx.tenantId, await jsonBody(req), c.actor);
    return ok(await view(c.ctx.tenantId));
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}
