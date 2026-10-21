/**
 * Authentication flows against a real Postgres database (DATABASE_URL or
 * TEST_DATABASE_URL). Route handlers are invoked directly with a `Request`, the
 * same objects Next.js hands them in production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { issueAuthToken } from "@/lib/auth/auth-tokens";
import { LOGIN_EMAIL_LIMIT, LOGIN_LOCKOUT_FAILURES, SESSION_COOKIE } from "@/lib/auth/constants";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { hashToken } from "@/lib/auth/tokens";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as forgot } from "@/app/api/auth/password/forgot/route";
import { POST as reset } from "@/app/api/auth/password/reset/route";
import { GET as me } from "@/app/api/me/route";
import { POST as inviteMember } from "@/app/api/users/route";
import { POST as resendInvite } from "@/app/api/users/[id]/invite/route";
import {
  cookieValue,
  createTenant,
  createUser,
  dbTestsEnabled,
  deleteTenants,
  request,
  sessionCookieFor,
} from "@/test/db";

const mailbox = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[] }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (message: { to: string; subject: string; text: string }) => {
    mailbox.sent.push(message);
  },
  mailer: () => ({ name: "console", send: async () => undefined }),
}));

const PASSWORD = "correct horse battery staple";

function linkToken(text: string): string {
  const url = /https?:\/\/\S+/.exec(text)?.[0];
  if (!url) throw new Error("no link in message");
  return new URL(url).pathname.split("/").pop()!;
}

describe.skipIf(!dbTestsEnabled)("authentication routes", () => {
  let tenantId: string;
  let ownerId: string;
  let ownerEmail: string;
  const created: string[] = [];

  beforeAll(async () => {
    const tenant = await createTenant();
    tenantId = tenant.id;
    created.push(tenant.id);
    const owner = await createUser({ tenantId, role: "CLINIC_OWNER", password: PASSWORD });
    ownerId = owner.id;
    ownerEmail = owner.email;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  beforeEach(() => {
    resetRateLimits();
    mailbox.sent.length = 0;
  });

  describe("POST /api/auth/login", () => {
    it("issues an httpOnly SameSite=Lax session cookie and records the sign-in", async () => {
      const res = await login(request("/api/auth/login", { body: { email: ownerEmail.toUpperCase(), password: PASSWORD, next: "/dashboard/patients" } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(ownerEmail);
      expect(body.tenant.id).toBe(tenantId);
      expect(body.redirectTo).toBe("/dashboard/patients");

      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/httponly/i);
      expect(setCookie).toMatch(/samesite=lax/i);
      const token = cookieValue(res, SESSION_COOKIE);
      expect(token).toBeTruthy();

      // Only the keyed hash is stored.
      const session = await db.session.findUnique({ where: { tokenHash: hashToken(token!, "session") } });
      expect(session?.userId).toBe(ownerId);
      expect(await db.session.findFirst({ where: { tokenHash: token! } })).toBeNull();

      const event = await db.loginEvent.findFirst({ where: { userId: ownerId, success: true } });
      expect(event).not.toBeNull();

      const whoami = await me(request("/api/me", { cookie: `${SESSION_COOKIE}=${token}` }));
      expect(whoami.status).toBe(200);
      expect((await whoami.json()).user.id).toBe(ownerId);
    });

    it("rejects a wrong password with 401 and records the failure", async () => {
      const before = await db.loginEvent.count({ where: { userId: ownerId, success: false } });
      const res = await login(request("/api/auth/login", { body: { email: ownerEmail, password: "wrong password here" } }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid_credentials");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await db.loginEvent.count({ where: { userId: ownerId, success: false } })).toBe(before + 1);
    });

    it("rejects an unknown e-mail with the same 401", async () => {
      const res = await login(request("/api/auth/login", { body: { email: "nobody@example.test", password: PASSWORD } }));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("invalid_credentials");
    });

    it("rejects users who have not accepted their invitation or were disabled", async () => {
      const invited = await createUser({ tenantId, role: "DOCTOR", status: "INVITED", password: null });
      const disabled = await createUser({ tenantId, role: "DOCTOR", status: "DISABLED", password: PASSWORD });
      for (const user of [invited, disabled]) {
        const res = await login(request("/api/auth/login", { body: { email: user.email, password: PASSWORD } }));
        expect(res.status).toBe(401);
      }
    });

    it("rejects a user whose tenant is not active", async () => {
      const suspended = await createTenant({ status: "SUSPENDED" });
      created.push(suspended.id);
      const user = await createUser({ tenantId: suspended.id, password: PASSWORD });
      const res = await login(request("/api/auth/login", { body: { email: user.email, password: PASSWORD } }));
      expect(res.status).toBe(401);
    });

    it("asks for the clinic when the same credentials exist in two tenants", async () => {
      const other = await createTenant();
      created.push(other.id);
      const email = `shared-${other.slug}@example.test`;
      await createUser({ tenantId, email, password: PASSWORD });
      await createUser({ tenantId: other.id, email, password: PASSWORD });

      const ambiguous = await login(request("/api/auth/login", { body: { email, password: PASSWORD } }));
      expect(ambiguous.status).toBe(401);
      expect((await ambiguous.json()).error).toBe("tenant_required");

      const scoped = await login(request("/api/auth/login", { body: { email, password: PASSWORD, tenant: other.slug } }));
      expect(scoped.status).toBe(200);
      expect((await scoped.json()).tenant.id).toBe(other.id);
    });

    it("locks an account after too many recorded failures", async () => {
      const victim = await createUser({ tenantId, password: PASSWORD });
      await db.loginEvent.createMany({
        data: Array.from({ length: LOGIN_LOCKOUT_FAILURES }, () => ({ userId: victim.id, success: false })),
      });
      const res = await login(request("/api/auth/login", { body: { email: victim.email, password: PASSWORD } }));
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("account_locked");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("throttles repeated attempts per e-mail address", async () => {
      const email = "guess-me@example.test";
      for (let i = 0; i < LOGIN_EMAIL_LIMIT; i++) {
        const res = await login(request("/api/auth/login", { body: { email, password: "nope nope nope" } }));
        expect(res.status).toBe(401);
      }
      const res = await login(request("/api/auth/login", { body: { email, password: "nope nope nope" } }));
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe("rate_limited");
    });

    it("rejects a cross-origin submission", async () => {
      const res = await login(
        request("/api/auth/login", {
          body: { email: ownerEmail, password: PASSWORD },
          headers: { origin: "https://evil.example", host: "localhost:3000" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("validates the body", async () => {
      const res = await login(request("/api/auth/login", { body: { email: "not-an-email", password: "" } }));
      expect(res.status).toBe(422);
    });
  });

  describe("sessions", () => {
    it("signs out: the session is revoked and the cookie cleared", async () => {
      const cookie = await sessionCookieFor(ownerId);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);

      const res = await logout(request("/api/auth/logout", { method: "POST", cookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
      expect(res.headers.get("set-cookie")).toMatch(/max-age=0/i);

      expect((await me(request("/api/me", { cookie }))).status).toBe(401);
      const token = cookie.split("=")[1]!;
      const row = await db.session.findUnique({ where: { tokenHash: hashToken(token, "session") } });
      expect(row?.revokedAt).not.toBeNull();
    });

    it("rejects an expired session", async () => {
      const cookie = await sessionCookieFor(ownerId);
      const token = cookie.split("=")[1]!;
      await db.session.update({
        where: { tokenHash: hashToken(token, "session") },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await me(request("/api/me", { cookie }))).status).toBe(401);
    });

    it("rejects the session of a user who was disabled", async () => {
      const user = await createUser({ tenantId, password: PASSWORD });
      const cookie = await sessionCookieFor(user.id);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);
      await db.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
      expect((await me(request("/api/me", { cookie }))).status).toBe(401);
    });
  });

  describe("invitations", () => {
    it("lets an owner invite staff who then set a password through a single-use link", async () => {
      const ownerCookie = await sessionCookieFor(ownerId);
      const email = `dr-new-${Date.now()}@example.test`;
      const res = await inviteMember(
        request("/api/users", { cookie: ownerCookie, body: { email, fullName: "Dr. New", role: "DOCTOR" } }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.status).toBe("INVITED");
      expect(body.inviteUrl).toMatch(/\/invite\//);
      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0]!.to).toBe(email);
      expect(linkToken(mailbox.sent[0]!.text)).toBe(new URL(body.inviteUrl).pathname.split("/").pop());

      // Can't sign in before accepting.
      expect((await login(request("/api/auth/login", { body: { email, password: PASSWORD } }))).status).toBe(401);

      const token = linkToken(body.inviteUrl);
      const accepted = await reset(request("/api/auth/password/reset", { body: { token, password: PASSWORD } }));
      expect(accepted.status).toBe(200);
      expect((await accepted.json()).kind).toBe("INVITE");
      const sessionToken = cookieValue(accepted, SESSION_COOKIE);
      expect(sessionToken).toBeTruthy();

      const user = await db.user.findUnique({ where: { id: body.user.id } });
      expect(user?.status).toBe("ACTIVE");
      expect(user?.passwordHash).toMatch(/^\$argon2id\$/);

      expect((await login(request("/api/auth/login", { body: { email, password: PASSWORD } }))).status).toBe(200);

      // The link is spent.
      const again = await reset(request("/api/auth/password/reset", { body: { token, password: "another long password" } }));
      expect(again.status).toBe(400);
      expect((await again.json()).error).toBe("used_token");
    });

    it("enforces the role ceiling and uniqueness", async () => {
      const ownerCookie = await sessionCookieFor(ownerId);
      const escalate = await inviteMember(
        request("/api/users", { cookie: ownerCookie, body: { email: "root@example.test", role: "SUPER_ADMIN" } }),
      );
      expect(escalate.status).toBe(403);
      const duplicate = await inviteMember(
        request("/api/users", { cookie: ownerCookie, body: { email: ownerEmail.toUpperCase(), role: "NURSE" } }),
      );
      expect(duplicate.status).toBe(409);
    });

    it("requires users:manage", async () => {
      const nurse = await createUser({ tenantId, role: "NURSE", password: PASSWORD });
      const res = await inviteMember(
        request("/api/users", { cookie: await sessionCookieFor(nurse.id), body: { email: "x@example.test", role: "NURSE" } }),
      );
      expect(res.status).toBe(403);
    });

    it("re-sending an invitation invalidates the previous link", async () => {
      const ownerCookie = await sessionCookieFor(ownerId);
      const invited = await createUser({ tenantId, role: "RECEPTIONIST", status: "INVITED", password: null });
      const first = await issueAuthToken(invited.id, "INVITE");
      const res = await resendInvite(request(`/api/users/${invited.id}/invite`, { method: "POST", cookie: ownerCookie }), { params: Promise.resolve({ id: invited.id }) });
      expect(res.status).toBe(200);
      const second = linkToken((await res.json()).inviteUrl);

      const stale = await reset(request("/api/auth/password/reset", { body: { token: first.token, password: PASSWORD } }));
      expect(stale.status).toBe(400);
      expect((await stale.json()).error).toBe("invalid_token");
      const fresh = await reset(request("/api/auth/password/reset", { body: { token: second, password: PASSWORD } }));
      expect(fresh.status).toBe(200);
    });
  });

  describe("password reset", () => {
    it("e-mails a link that sets a new password and revokes other sessions", async () => {
      const user = await createUser({ tenantId, password: PASSWORD });
      const oldCookie = await sessionCookieFor(user.id);

      const res = await forgot(request("/api/auth/password/forgot", { body: { email: user.email } }));
      expect(res.status).toBe(200);
      expect(mailbox.sent).toHaveLength(1);
      const token = linkToken(mailbox.sent[0]!.text);

      const newPassword = "a brand new passphrase";
      const done = await reset(request("/api/auth/password/reset", { body: { token, password: newPassword } }));
      expect(done.status).toBe(200);
      expect((await done.json()).kind).toBe("PASSWORD_RESET");

      expect((await me(request("/api/me", { cookie: oldCookie }))).status).toBe(401);
      expect((await login(request("/api/auth/login", { body: { email: user.email, password: PASSWORD } }))).status).toBe(401);
      expect((await login(request("/api/auth/login", { body: { email: user.email, password: newPassword } }))).status).toBe(200);
    });

    it("answers identically for unknown addresses and sends nothing", async () => {
      const res = await forgot(request("/api/auth/password/forgot", { body: { email: "ghost@example.test" } }));
      expect(res.status).toBe(200);
      expect(mailbox.sent).toHaveLength(0);
    });

    it("sends an invitation instead to a user who never set a password", async () => {
      const invited = await createUser({ tenantId, status: "INVITED", password: null });
      await forgot(request("/api/auth/password/forgot", { body: { email: invited.email } }));
      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0]!.text).toContain("/invite/");
    });

    it("rejects expired links and weak passwords", async () => {
      const user = await createUser({ tenantId, password: PASSWORD });
      const issued = await issueAuthToken(user.id, "PASSWORD_RESET");
      const weak = await reset(request("/api/auth/password/reset", { body: { token: issued.token, password: "short" } }));
      expect(weak.status).toBe(422);

      await db.authToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1) } });
      const expired = await reset(request("/api/auth/password/reset", { body: { token: issued.token, password: PASSWORD } }));
      expect(expired.status).toBe(400);
      expect((await expired.json()).error).toBe("expired_token");
    });
  });
});
