import { redirect } from "next/navigation";
import { auth } from "./auth";

export type SessionUser = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  isSuperAdmin: boolean;
  clientId: string | null;
  permissions: string[];
  roleNames: string[];
  email?: string | null;
  name?: string | null;
};

/** Require any authenticated user. */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.tenantId) redirect("/login");
  return session.user as SessionUser;
}

/** Require an internal team member (not a client-portal user). */
export async function requireTeamUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.clientId) redirect(`/client/${user.tenantSlug}`);
  return user;
}

/** Require a specific RBAC permission key (admins pass everything). */
export async function requirePermission(permission: string): Promise<SessionUser> {
  const user = await requireTeamUser();
  if (user.isSuperAdmin || user.roleNames.includes("Admin")) return user;
  if (!user.permissions.includes(permission)) redirect("/dashboard?error=forbidden");
  return user;
}

export function hasPermission(user: SessionUser, permission: string): boolean {
  return (
    user.isSuperAdmin || user.roleNames.includes("Admin") || user.permissions.includes(permission)
  );
}
