import type { ActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import type { Actor } from "@/modules/quotes/service";

/** Who is acting, as the quote service records it (the role limits discounts). */
export function actorOf(ctx: ActingContext, req: Request): Actor {
  return { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role };
}
