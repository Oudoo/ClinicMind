import { cookies, headers } from "next/headers";
import type { UserRole } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyEmbedToken } from "@/lib/embed";
import {
  EMBED_COOKIE,
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL_MS,
  SESSION_TTL_MS,
} from "./constants";
import { readCookie } from "./request";
import { generateToken, hashToken } from "./tokens";

/**
 * Acting context: who is making this request, for which tenant, with which
 * role. Every protected route handler and the dashboard layout start here.
 *
 * A context is returned only when the request proves an identity:
 *   1. a staff session — httpOnly `cm_session` cookie whose keyed hash matches
 *      a live row in `Session` (issued by POST /api/auth/login), or
 *   2. a verified embed token — `cm_embed` cookie or `Authorization: Bearer`,
 *      minted server-to-server at POST /api/embed/token for a framed surface.
 *
 * There is deliberately no host/header-based tenant resolution and no
 * development fallback: an unauthenticated request is unauthenticated
 * everywhere. Tests obtain a context by creating a real session with
 * `createSession()` and sending its cookie.
 */
export interface ActingContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  branding: unknown;
  userId: string | null;
  email: string | null;
  fullName: string | null;
  role: UserRole;
  /** How the caller proved who they are. */
  auth: { method: "session"; sessionId: string } | { method: "embed" };
}

interface CredentialSource {
  cookie(name: string): string | undefined;
  header(name: string): string | null;
}

/**
 * Resolve the acting context. Route handlers pass their `Request` (which also
 * makes them testable outside the Next.js runtime); Server Components omit it
 * and the request-scoped stores from `next/headers` are used.
 */
export async function getActingContext(req?: Request): Promise<ActingContext | null> {
  const source: CredentialSource = req
    ? { cookie: (name) => readCookie(req, name), header: (name) => req.headers.get(name) }
    : { cookie: (name) => cookies().get(name)?.value, header: (name) => headers().get(name) };

  const sessionToken = source.cookie(SESSION_COOKIE);
  if (sessionToken) {
    const ctx = await contextFromSessionToken(sessionToken);
    if (ctx) return ctx;
  }

  const bearer = source.header("authorization")?.replace(/^Bearer\s+/i, "");
  const embedToken = source.cookie(EMBED_COOKIE) ?? bearer;
  if (embedToken) {
    const ctx = await contextFromEmbedToken(embedToken);
    if (ctx) return ctx;
  }

  return null;
}

// ── Staff sessions ───────────────────────────────────────────────────────────

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
  device?: string | null;
}

export interface IssuedSession {
  /** Raw token for the cookie. Never stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/** Create a session row for a user and return the raw cookie token. */
export async function createSession(userId: string, meta: SessionMeta = {}): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token, "session"),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      device: meta.device ?? null,
      expiresAt,
    },
    select: { id: true },
  });
  return { token, sessionId: session.id, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every live session of a user (password change, account disabled). */
export async function revokeAllSessions(userId: string, opts: { except?: string } = {}): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(opts.except ? { id: { not: opts.except } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Cookie attributes for the session cookie. `Secure` is set whenever the app
 * is served over HTTPS (APP_URL) and always in production, except for a
 * production build pointed at localhost (the Compose demo), which browsers
 * other than Chrome would otherwise refuse the cookie for.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export function clearedCookieOptions() {
  return { ...sessionCookieOptions(new Date(0)), maxAge: 0 };
}

function cookieSecure(): boolean {
  let url: URL;
  try {
    url = new URL(env.APP_URL);
  } catch {
    return env.NODE_ENV === "production";
  }
  if (url.protocol === "https:") return true;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return env.NODE_ENV === "production" && !local;
}

async function contextFromSessionToken(token: string): Promise<ActingContext | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token, "session") },
    include: {
      user: {
        include: {
          tenant: {
            select: { id: true, slug: true, name: true, branding: true, status: true, deletedAt: true },
          },
        },
      },
    },
  });

  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now) return null;

  const { user } = session;
  if (user.deletedAt || user.status !== "ACTIVE") return null;
  if (user.tenant.deletedAt || user.tenant.status !== "ACTIVE") return null;

  if (now.getTime() - session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: now } })
      .catch(() => undefined);
  }

  return {
    tenantId: user.tenant.id,
    tenantSlug: user.tenant.slug,
    tenantName: user.tenant.name,
    branding: user.tenant.branding,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    auth: { method: "session", sessionId: session.id },
  };
}

// ── Embed tokens ─────────────────────────────────────────────────────────────

async function contextFromEmbedToken(token: string): Promise<ActingContext | null> {
  let claims;
  try {
    claims = await verifyEmbedToken(token);
  } catch {
    return null;
  }
  const tenant = await db.tenant.findFirst({
    where: { id: claims.tenantId, deletedAt: null },
    select: { id: true, slug: true, name: true, branding: true },
  });
  if (!tenant) return null;
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    branding: tenant.branding,
    userId: claims.userId,
    email: null,
    fullName: null,
    role: (claims.role as UserRole) ?? "ASSISTANT",
    auth: { method: "embed" },
  };
}
