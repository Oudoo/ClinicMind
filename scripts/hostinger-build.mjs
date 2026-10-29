#!/usr/bin/env node
/**
 * The build Hostinger's Node.js web hosting runs: the "build" script of the bundle
 * scripts/hostinger-package.sh makes (docs/HOSTINGER.md). The database first, then the app:
 *
 *   1. prisma generate;
 *   2. prisma migrate deploy, as the owner (SYSTEM_DATABASE_URL);
 *   3. clinicmind_app gets the password DATABASE_URL carries, and a connection as it is checked:
 *      the clinic isolation rules bind it (src/lib/db.ts), and each clinic's connections carry
 *      their clinic as a startup option, which the database must accept;
 *   4. the demo clinic, once: when SEED_DEMO_PASSWORD is set and there is no demo clinic yet,
 *      or on every build while RESEED_DEMO=yes (it rebuilds the demo clinic around today);
 *   5. next build with webpack, one worker and few threads: the hosting counts every process
 *      and thread of the account against a small limit;
 *   6. the static files and public/ next to the standalone server.
 *
 * The values come from the website's environment variables in hPanel; nothing here prints them.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();
const bin = (name) => path.join(root, "node_modules", ".bin", name);

// Few threads in every step: Prisma's engine and the bundler size their pools by the
// server's CPU count, which on shared hosting is far above what the account may run.
process.env.TOKIO_WORKER_THREADS ||= "2";
process.env.RAYON_NUM_THREADS ||= "2";
process.env.NEXT_BUILD_CPUS ||= "1";
process.env.NEXT_TELEMETRY_DISABLED ||= "1";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(title, run) {
  const started = Date.now();
  console.log(`\n▶ ${title}`);
  const result = run();
  console.log(`  done in ${Math.round((Date.now() - started) / 1000)} s`);
  return result;
}

function exec(command, args, env = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) fail(`${path.basename(command)} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
}

/** The parts of a postgres connection string, or null. */
function parseUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/^postgres(ql)?:$/.test(url.protocol)) return null;
    return { url, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  } catch {
    return null;
  }
}

/** `raw` with one more startup option, percent-encoded the way Prisma reads it (as src/lib/db.ts does). */
function withOption(raw, option) {
  const [base, query = ""] = raw.split("?");
  const params = query.split("&").filter(Boolean);
  const at = params.findIndex((p) => p.split("=")[0] === "options");
  const current = at >= 0 ? decodeURIComponent(params[at].slice("options=".length)) : "";
  const value = `options=${encodeURIComponent(`${current} ${option}`.trim())}`;
  if (at >= 0) params[at] = value;
  else params.push(value);
  return `${base}?${params.join("&")}`;
}

// ── Configuration ────────────────────────────────────────────────────────────
const appUrl = process.env.DATABASE_URL ?? "";
const ownerUrl = process.env.SYSTEM_DATABASE_URL ?? "";
const app = parseUrl(appUrl);
const owner = parseUrl(ownerUrl);
const missing = [];
if (!owner) missing.push("SYSTEM_DATABASE_URL (the database's connection string, as its owner)");
if (!app) missing.push("DATABASE_URL (the same database, as clinicmind_app with its own password)");
for (const key of ["AUTH_SECRET", "EMBED_SIGNING_SECRET"]) if ((process.env[key] ?? "").length < 32) missing.push(`${key} (32 or more random characters)`);
if (!/^https?:\/\//.test(process.env.APP_URL ?? "")) missing.push("APP_URL (the website's address, e.g. https://demo.example.com)");
if (missing.length) fail(`Set these environment variables for the website in hPanel, then deploy again:\n  - ${missing.join("\n  - ")}\nSee HOSTINGER.md.`);
if (owner.url.host !== app.url.host || owner.url.pathname !== app.url.pathname) fail("DATABASE_URL and SYSTEM_DATABASE_URL must name the same database (same host and database name).");
if (/-pooler\./.test(owner.url.hostname) || /-pooler\./.test(app.url.hostname)) {
  fail("Use the database's direct connection string, not the pooled one (its host has -pooler): each clinic's connections carry their clinic as a startup option, which a pooler drops.");
}
const ownerEnv = { DATABASE_URL: ownerUrl };

// ── 1-2. Client and schema ───────────────────────────────────────────────────
step("Prisma client", () => exec(bin("prisma"), ["generate"]));
step("Database schema (prisma migrate deploy, as the owner)", () => exec(bin("prisma"), ["migrate", "deploy"], ownerEnv));

// ── 3. The application's role ────────────────────────────────────────────────
if (app.user === "clinicmind_app") {
  if (!/^[A-Za-z0-9._~-]{16,}$/.test(app.password)) fail("The password in DATABASE_URL must be 16 or more letters, digits, '.', '_', '~' or '-'.");
  step("The application's database role (clinicmind_app)", () => exec(bin("tsx"), ["scripts/db-app-role.ts"], { ...ownerEnv, APP_DB_PASSWORD: app.password }));
} else {
  console.warn(`\n⚠ DATABASE_URL connects as "${app.user}", not clinicmind_app: the clinic isolation rules do not bind it. See HOSTINGER.md.`);
}

const { PrismaClient } = require("@prisma/client");
async function query(url, sql) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    return await client.$queryRawUnsafe(sql);
  } finally {
    await client.$disconnect();
  }
}

await (async () => {
  console.log("\n▶ Connection check");
  const [probe] = await query(withOption(appUrl, "-c app.current_tenant=hostinger-probe"),"SELECT current_user AS who, current_setting('app.current_tenant', true) AS tenant, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypasses");
  if (probe?.tenant !== "hostinger-probe") fail("The database dropped the connection option that carries the clinic: use its direct connection string (not a pooled one).");
  console.log(`  the app connects as ${probe.who}; clinic isolation ${probe.bypasses ? "is NOT enforced (the role bypasses it)" : "is enforced"}`);
})();

// ── 4. The demo clinic ───────────────────────────────────────────────────────
await (async () => {
  const reseed = /^(1|yes|true)$/i.test(process.env.RESEED_DEMO ?? "");
  // The assistant's index is the seed's last step: without it, a build stopped half way left the
  // demo clinic unfinished, and the seed starts it again (it removes the old one first).
  const [{ count }] = await query(ownerUrl, `SELECT count(*)::int AS count FROM tenants t WHERE t.slug = 'demo' AND EXISTS (SELECT 1 FROM knowledge_embeddings k WHERE k."tenantId" = t.id)`);
  if (!reseed && count > 0) return console.log("\n▶ Demo clinic: already there (RESEED_DEMO=yes rebuilds it)");
  if (!process.env.SEED_DEMO_PASSWORD) return console.log("\n▶ Demo clinic: not created (set SEED_DEMO_PASSWORD to create it)");
  step(reseed && count > 0 ? "Demo clinic: rebuilding it around today" : "Demo clinic: creating it", () => exec(bin("tsx"), ["prisma/seed.ts"]));
})();

// ── 5-6. The application ─────────────────────────────────────────────────────
// webpack, not Turbopack: on Hostinger's build servers Turbopack's PostCSS loader runs in a
// Node process it starts and connects to, and that process exits before it connects.
step("Next.js build (webpack)", () => exec(bin("next"), ["build", "--webpack"]));
step("Static files next to the standalone server", () => {
  const standalone = path.join(root, ".next", "standalone");
  if (!existsSync(standalone)) fail(".next/standalone is missing: next.config.mjs must keep output: \"standalone\".");
  cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
  if (existsSync(path.join(root, "public"))) cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });
});
console.log("\n✓ Built. Hostinger starts the server; sign in at APP_URL/login.");
