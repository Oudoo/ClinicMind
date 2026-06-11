import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.clientId) redirect(`/client/${session.user.tenantSlug}`);
  redirect("/dashboard");
}
