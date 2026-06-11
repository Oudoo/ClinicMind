import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  db,
  users,
  tenants,
  userRoles,
  rolePermissions,
  permissions,
  roles,
} from "@growengine/db";

/**
 * Auth.js v5 — credentials auth with strict multi-tenant JWT sessions.
 * The session carries tenantId + permission keys; every data access path
 * scopes queries by session.tenantId (no cross-tenant reads possible).
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string;
      tenantSlug: string;
      isSuperAdmin: boolean;
      /** Set for client-portal users; scopes them to one client */
      clientId: string | null;
      permissions: string[];
      roleNames: string[];
    } & DefaultSession["user"];
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret: process.env.AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt", maxAge: 12 * 3600 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        tenantSlug: { label: "Workspace", type: "text" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").toLowerCase().trim();
        const password = String(credentials?.password ?? "");
        const tenantSlug = String(credentials?.tenantSlug ?? "").toLowerCase().trim();
        if (!email || !password || !tenantSlug) return null;

        const [tenant] = await db
          .select()
          .from(tenants)
          .where(eq(tenants.slug, tenantSlug));
        if (!tenant || tenant.status === "suspended") return null;

        const [user] = await db
          .select()
          .from(users)
          .where(and(eq(users.tenantId, tenant.id), eq(users.email, email)));
        if (!user || user.status !== "active" || !user.passwordHash) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        // Resolve RBAC permissions at login; embedded in the JWT
        const permRows = await db
          .select({ key: permissions.key, roleName: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(userRoles.userId, user.id));

        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          isSuperAdmin: user.isSuperAdmin,
          clientId: user.clientId,
          permissions: [...new Set(permRows.map((p) => p.key))],
          roleNames: [...new Set(permRows.map((p) => p.roleName))],
        } as never;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const u = user as unknown as Record<string, unknown>;
        token.id = u.id;
        token.tenantId = u.tenantId;
        token.tenantSlug = u.tenantSlug;
        token.isSuperAdmin = u.isSuperAdmin;
        token.clientId = u.clientId;
        token.permissions = u.permissions;
        token.roleNames = u.roleNames;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.tenantId = token.tenantId as string;
      session.user.tenantSlug = token.tenantSlug as string;
      session.user.isSuperAdmin = Boolean(token.isSuperAdmin);
      session.user.clientId = (token.clientId as string | null) ?? null;
      session.user.permissions = (token.permissions as string[]) ?? [];
      session.user.roleNames = (token.roleNames as string[]) ?? [];
      return session;
    },
  },
});
