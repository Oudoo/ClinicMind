import type { Permission } from "@/lib/auth/rbac";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp } from "@/lib/auth/request";
import { getActingContext, type ActingContext } from "@/lib/auth/session";
import { ConciergeError } from "@/modules/concierge/errors";
import type { Actor } from "@/modules/concierge/shared";

/** The acting staff member for a concierge route, or null (→ 401). Throws `RbacError` (→ 403) without the permission. */
export async function conciergeContext(req: Request, permission: Permission): Promise<{ ctx: ActingContext; actor: Actor } | null> {
  const ctx = await getActingContext(req);
  if (!ctx) return null;
  assertCan(ctx.role, permission);
  return { ctx, actor: { id: ctx.userId, email: ctx.email, ip: clientIp(req) } };
}

/** The JSON body, or an empty object when there is none (POST actions without a body); 422 when it is not JSON. */
export async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConciergeError("validation_error", "The request body is not valid JSON", 422);
  }
}

export type IdParams = { params: Promise<{ id: string }> };

/** The JSON body as an object (anything else — an array, a number, null — reads as `{}`). */
export async function objectBody(req: Request): Promise<Record<string, unknown>> {
  const body = await jsonBody(req);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
