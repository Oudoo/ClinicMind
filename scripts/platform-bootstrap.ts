/**
 * Create (or re-invite) a platform administrator.
 *
 *   npm run platform:bootstrap -- --email admin@example.com [--name "Full Name"] [--platform-name "GrowCDX Platform"]
 *
 * Ensures the platform tenant exists and that the e-mail belongs to a
 * SUPER_ADMIN in it, then prints a single-use invitation link (valid 7 days)
 * to choose a password. Safe to re-run: an active administrator is left alone
 * and told to use /forgot-password instead.
 */
import { systemDb, withSystem } from "../src/lib/db";
import { inviteUser } from "../src/lib/auth/auth-tokens";
import { normalizeEmail } from "../src/lib/auth/request";
import { PLATFORM_TENANT_SLUG } from "../src/modules/platform/service";

function arg(name: string): string | undefined {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const rawEmail = arg("--email");
  if (!rawEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail)) {
    console.error('Usage: npm run platform:bootstrap -- --email admin@example.com [--name "Full Name"] [--platform-name "GrowCDX Platform"]');
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);
  const fullName = arg("--name") ?? null;
  const platformName = arg("--platform-name") ?? "ClinicMind Platform";

  const tenant = await systemDb.tenant.upsert({
    where: { slug: PLATFORM_TENANT_SLUG },
    create: { slug: PLATFORM_TENANT_SLUG, name: platformName, status: "ACTIVE", settings: { platform: true } },
    update: {},
    select: { id: true, name: true },
  });

  let user = await systemDb.user.findFirst({
    where: { tenantId: tenant.id, email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true, email: true, fullName: true, role: true, status: true, passwordHash: true },
  });

  if (user && user.status === "ACTIVE" && user.passwordHash) {
    if (user.role !== "SUPER_ADMIN") {
      await systemDb.user.update({ where: { id: user.id }, data: { role: "SUPER_ADMIN" } });
      console.log(`✅ ${user.email} promoted to SUPER_ADMIN.`);
    } else {
      console.log(`ℹ️  ${user.email} is already an active platform administrator. Use /forgot-password to reset the password.`);
    }
    return;
  }

  if (!user) {
    user = await systemDb.user.create({
      data: { tenantId: tenant.id, email, fullName, role: "SUPER_ADMIN", status: "INVITED" },
      select: { id: true, email: true, fullName: true, role: true, status: true, passwordHash: true },
    });
    console.log(`✅ Created platform administrator ${user.email} in "${tenant.name}".`);
  } else if (user.role !== "SUPER_ADMIN") {
    await systemDb.user.update({ where: { id: user.id }, data: { role: "SUPER_ADMIN" } });
  }

  const invite = await inviteUser({ id: user.id, email: user.email, fullName: user.fullName, tenantName: tenant.name });
  await systemDb.auditLog.create({
    data: { tenantId: tenant.id, actorEmail: "platform-bootstrap", action: "platform.admin.invite", entity: "User", entityId: user.id, after: { email: user.email } },
  });
  console.log("");
  console.log(`   Invitation (valid until ${invite.expiresAt.toISOString()}):`);
  console.log(`   ${invite.url}`);
  console.log("");
  console.log("   After choosing a password, sign in at /login — platform administrators land on /platform.");
}

// An operator script: it works across clinics, outside row-level security (src/lib/db.ts).
withSystem(main)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => systemDb.$disconnect());
