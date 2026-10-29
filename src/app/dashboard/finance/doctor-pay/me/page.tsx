import { redirect } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** `/dashboard/finance/doctor-pay/me` — "My pay": the signed-in doctor's own statement. */
export default async function MyPayPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;
  redirect(`/dashboard/finance/doctor-pay/${ctx.userId}`);
}
