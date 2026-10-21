import type { AuthTokenKind } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { sendMail } from "@/lib/mailer";
import { INVITE_TTL_MS, PASSWORD_RESET_TTL_MS } from "./constants";
import { hashPassword } from "./password";
import { normalizeEmail } from "./request";
import { createSession, revokeAllSessions, type IssuedSession, type SessionMeta } from "./session";
import { generateToken, hashToken } from "./tokens";

/**
 * Invitation and password-reset links.
 *
 * Both are the same mechanism: a single-use `AuthToken` row (hashed, expiring)
 * that lets the holder set the user's password. Accepting an invitation also
 * activates the user. Issuing a new token of a kind replaces any unused one of
 * the same kind for that user, so only the most recent link works.
 */

export interface IssuedAuthToken {
  token: string;
  url: string;
  expiresAt: Date;
}

export async function issueAuthToken(userId: string, kind: AuthTokenKind): Promise<IssuedAuthToken> {
  const token = generateToken();
  const ttl = kind === "INVITE" ? INVITE_TTL_MS : PASSWORD_RESET_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await db.$transaction([
    db.authToken.deleteMany({ where: { userId, kind, usedAt: null } }),
    db.authToken.create({
      data: { userId, kind, tokenHash: hashToken(token, "auth-token"), expiresAt },
    }),
  ]);
  return { token, url: authTokenUrl(kind, token), expiresAt };
}

export function authTokenUrl(kind: AuthTokenKind, token: string): string {
  const base = env.APP_URL.replace(/\/$/, "");
  return `${base}/${kind === "INVITE" ? "invite" : "reset-password"}/${token}`;
}

export type AuthTokenLookup =
  | {
      status: "valid";
      tokenId: string;
      kind: AuthTokenKind;
      user: { id: string; email: string; fullName: string | null; status: string; tenantName: string };
    }
  | { status: "invalid" | "expired" | "used" };

/** Look a token up without consuming it (used to render the set-password page). */
export async function inspectAuthToken(token: string): Promise<AuthTokenLookup> {
  if (!token || token.length > 128) return { status: "invalid" };
  const row = await db.authToken.findUnique({
    where: { tokenHash: hashToken(token, "auth-token") },
    include: {
      user: {
        include: { tenant: { select: { name: true, status: true, deletedAt: true } } },
      },
    },
  });
  if (!row) return { status: "invalid" };
  if (row.usedAt) return { status: "used" };
  if (row.expiresAt <= new Date()) return { status: "expired" };
  const { user } = row;
  if (user.deletedAt || user.status === "DISABLED") return { status: "invalid" };
  if (user.tenant.deletedAt || user.tenant.status !== "ACTIVE") return { status: "invalid" };
  return {
    status: "valid",
    tokenId: row.id,
    kind: row.kind,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      tenantName: user.tenant.name,
    },
  };
}

export type SetPasswordResult =
  | { ok: true; userId: string; kind: AuthTokenKind; session: IssuedSession }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Consume a token and set the user's password. The token is marked used
 * atomically so a second submission of the same link fails; every other session
 * of the user is revoked and a fresh one is issued for the caller.
 */
export async function setPasswordWithToken(
  token: string,
  password: string,
  meta: SessionMeta = {},
): Promise<SetPasswordResult> {
  const lookup = await inspectAuthToken(token);
  if (lookup.status !== "valid") return { ok: false, reason: lookup.status };

  const consumed = await db.authToken.updateMany({
    where: { id: lookup.tokenId, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count === 0) return { ok: false, reason: "used" };

  const passwordHash = await hashPassword(password);
  const user = await db.user.update({
    where: { id: lookup.user.id },
    data: { passwordHash, status: "ACTIVE" },
    select: { id: true, tenantId: true, email: true, status: true },
  });

  await revokeAllSessions(user.id);
  const session = await createSession(user.id, meta);

  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    action: lookup.kind === "INVITE" ? "user.invite.accept" : "user.password.reset",
    entity: "User",
    entityId: user.id,
    ip: meta.ip,
    device: meta.userAgent,
    before: { status: lookup.user.status },
    after: { status: "ACTIVE" },
  });

  return { ok: true, userId: user.id, kind: lookup.kind, session };
}

/**
 * Issue (or re-issue) an invitation for a user who has not set a password yet
 * and e-mail the link. Returns the link so the inviting administrator can also
 * hand it over directly.
 */
export async function inviteUser(user: {
  id: string;
  email: string;
  fullName: string | null;
  tenantName: string;
}): Promise<IssuedAuthToken> {
  const issued = await issueAuthToken(user.id, "INVITE");
  await sendMail({
    to: user.email,
    subject: `You have been invited to ${user.tenantName} on ClinicMind`,
    text:
      `Hello${user.fullName ? ` ${user.fullName}` : ""},\n\n` +
      `You have been invited to join ${user.tenantName} on ClinicMind. ` +
      `Open the link below to choose your password:\n\n` +
      `${issued.url}\n\n` +
      `The link works once and expires on ${issued.expiresAt.toUTCString()}.`,
  });
  return issued;
}

/**
 * Password-reset request. Never reveals whether an account exists: every
 * matching, non-disabled user (there can be one per tenant) gets a link; an
 * invited user who has not set a password yet gets a fresh invitation instead.
 */
export async function requestPasswordReset(input: {
  email: string;
  tenantSlug?: string | null;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const users = await db.user.findMany({
    where: {
      email: { equals: email, mode: "insensitive" },
      deletedAt: null,
      status: { in: ["ACTIVE", "INVITED"] },
      tenant: {
        deletedAt: null,
        status: "ACTIVE",
        ...(input.tenantSlug ? { slug: input.tenantSlug } : {}),
      },
    },
    include: { tenant: { select: { name: true } } },
    take: 10,
  });

  for (const user of users) {
    if (user.status === "INVITED") {
      await inviteUser({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        tenantName: user.tenant.name,
      });
      continue;
    }
    const issued = await issueAuthToken(user.id, "PASSWORD_RESET");
    await sendMail({
      to: user.email,
      subject: `Reset your ${user.tenant.name} ClinicMind password`,
      text:
        `Hello${user.fullName ? ` ${user.fullName}` : ""},\n\n` +
        `Someone asked to reset the password of your ${user.tenant.name} account. ` +
        `If that was you, open the link below to choose a new password:\n\n` +
        `${issued.url}\n\n` +
        `The link works once and expires on ${issued.expiresAt.toUTCString()}. ` +
        `If you did not request this, you can ignore this message; your password is unchanged.`,
    });
  }
}
