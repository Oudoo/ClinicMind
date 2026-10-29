import { NextResponse } from "next/server";
import { getActingContext } from "@/lib/auth/session";
import { assertCan, type Permission } from "@/lib/auth/rbac";
import { clientIp } from "@/lib/auth/request";
import type { ExpenseActor } from "@/modules/finance/expenses";

export type IdParams = { params: Promise<{ id: string }> };

/** The request's session with `permission` checked, and the actor the expense service records (with their role). */
export async function expenseContext(req: Request, permission: Permission) {
  const ctx = await getActingContext(req);
  if (!ctx) return null;
  assertCan(ctx.role, permission);
  const actor: ExpenseActor = { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role };
  return { ctx, actor };
}

/** One photo or PDF of 5 MB is about 6.7 MB in base64: a request takes one at a time (the proxy buffers 10 MB). */
export const MAX_BODY_BYTES = 9 * 1024 * 1024;

/** The JSON body, or a 413 when it is larger than a request may be. */
export async function boundedJson(req: Request): Promise<{ body: unknown } | { response: NextResponse }> {
  const tooLarge = () => ({ response: NextResponse.json({ error: "payload_too_large", message: "Send one photo or PDF at a time, each 5 MB or smaller." }, { status: 413 }) });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return tooLarge();
  try {
    return { body: text.trim() ? JSON.parse(text) : null };
  } catch {
    return { body: null };
  }
}
