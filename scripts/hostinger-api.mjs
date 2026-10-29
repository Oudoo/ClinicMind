#!/usr/bin/env node
// Work on the Hostinger account through Hostinger's own API server (the npm package
// hostinger-api-mcp, spoken to over stdio), from the "Hostinger" GitHub workflow where
// HOSTINGER_API_TOKEN is a repository secret:
//
//   node scripts/hostinger-api.mjs deploy/hostinger/request.json
//
// The request file says what to do:
//   { "action": "inventory", "zones": ["growcdx.com"] }
//       read only: the plans, websites, VPS, domains and DNS records the account has.
//   { "action": "deploy", "domain": "cm.growcdx.com", "app": ".hostinger/app" }
//       the demo on the Node.js web hosting (docs/HOSTINGER.md): creates the website on the
//       Business or Cloud plan when it is not there, sets its environment variables, uploads
//       the bundle scripts/hostinger-package.sh made, follows the build and checks the site.
//       Needs DEMO_DATABASE_URL (PostgreSQL outside Hostinger); the app's database password
//       and its secrets are derived from it, so they stay the same from one deploy to the next.
//       "reseed": true rebuilds the demo clinic around today.
//   { "action": "status", "domain": "cm.growcdx.com" }
//       read only: the last build, the app's log ("logPeriod", 24h by default) and its errors,
//       its environment variable names, the SSL and CDN settings and a health check. The
//       "Hostinger status" workflow runs it from deploy/hostinger/status.json, beside a deploy.
//       "restart": true restarts the app first (Hostinger's remedy for a hung process).
//
// The repository is public, so its workflow logs are too: this prints plan names, states and
// domain names, never account user names, IP addresses, e-mail addresses or secret values.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PACKAGE = "hostinger-api-mcp@3.22.3";

class HostingerApi {
  #child;
  #next = 1;
  #pending = new Map();
  #stderr = [];

  async start() {
    if (!process.env.HOSTINGER_API_TOKEN) throw new Error("HOSTINGER_API_TOKEN is not set: add it as a repository secret (Settings → Secrets and variables → Actions).");
    // HOSTINGER_API_SERVER: a local stand-in for the package, for testing this script.
    const [command, ...args] = process.env.HOSTINGER_API_SERVER ? ["node", process.env.HOSTINGER_API_SERVER] : ["npx", "--yes", PACKAGE];
    this.#child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DEBUG: "false" } });
    // The server's own log stays out of the public workflow log unless a call fails.
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr.push(String(chunk));
      if (this.#stderr.length > 50) this.#stderr.shift();
    });
    readline.createInterface({ input: this.#child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = message.id !== undefined ? this.#pending.get(message.id) : undefined;
      if (!waiting) return;
      this.#pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
    this.#child.on("exit", (code) => {
      for (const waiting of this.#pending.values()) waiting.reject(new Error(`the Hostinger API server stopped (exit ${code})`));
      this.#pending.clear();
    });
    await this.#request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clinicmind-deploy", version: "1.0.0" } }, 180_000);
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  stop() {
    this.#child?.stdin.end();
    this.#child?.kill();
  }

  /** The server's recent log lines, for a failure. */
  recentLog() {
    return this.#stderr.join("").split("\n").slice(-20).join("\n");
  }

  #send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params, timeoutMs = 600_000) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** One API operation (the server runs them through its `execute` tool): its JSON answer, or an error with the server's explanation. */
  async call(operation, params = {}, timeoutMs) {
    const result = await this.#request("tools/call", { name: "execute", arguments: { operation, params } }, timeoutMs);
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain text answer
    }
    if (result?.isError) throw new Error(`${operation}: ${typeof data === "string" ? data : JSON.stringify(data)}`.slice(0, 2000));
    return data;
  }
}

/**
 * An IP address as the public log shows it: loopback and the any-address as they are, any other
 * as a numbered private or public address, so two can be told apart without showing either.
 */
const addressLabels = new Map();
function addressLabel(ip) {
  if (/^127\./.test(ip) || ip === "0.0.0.0") return ip;
  if (!addressLabels.has(ip)) {
    const [a, b] = ip.split(".").map(Number);
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    addressLabels.set(ip, `‹${isPrivate ? "private" : "public"} address ${addressLabels.size + 1}›`);
  }
  return addressLabels.get(ip);
}

/**
 * Text for the public log: hosting user names, e-mail and IP addresses masked, and what the
 * demo seed prints that works as a key (the embed secret, the links patients open).
 */
const redact = (text) =>
  String(text)
    .replace(/\bu\d{5,}\b/g, "u…")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "…@…")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, addressLabel)
    .replace(/cmembed_[A-Za-z0-9_-]+/g, "cmembed_…")
    .replace(/\/[A-Za-z0-9_-]{24,}/g, "/…");

/** The rows of a list answer, whether it is a bare array or `{ data: [...] }`. */
const rowsOf = (answer) => (Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : []);
const show = (value) => (value === undefined || value === null || value === "" ? "-" : String(value));
/** The first of these fields a row has. */
const field = (row, ...names) => names.map((n) => n.split(".").reduce((v, k) => v?.[k], row)).find((v) => v !== undefined && v !== null && v !== "");

async function section(title, run) {
  console.log(`\n▶ ${title}`);
  try {
    await run();
  } catch (err) {
    console.log(`  could not read: ${redact(err instanceof Error ? err.message : err)}`);
  }
}

async function inventory(api, request) {
  await section("Subscriptions", async () => {
    const rows = rowsOf(await api.call("billing_subscriptions_list"));
    if (!rows.length) console.log("  none");
    for (const s of rows) console.log(`  ${show(field(s, "name", "plan.name", "product.name"))}  status=${show(field(s, "status"))}  until=${show(field(s, "expires_at", "next_billing_at", "renewal_date"))}`);
    if (rows[0]) console.log(`  (fields: ${Object.keys(rows[0]).join(", ")})`);
  });
  await section("Web and Cloud hosting orders", async () => {
    const rows = rowsOf(await api.call("hosting_orders_list"));
    if (!rows.length) console.log("  none");
    for (const o of rows) console.log(`  order ${show(o.id)}  ${show(field(o, "plan.name", "plan", "name", "product_name"))}  status=${show(field(o, "status"))}`);
    if (rows[0]) console.log(`  (fields: ${Object.keys(rows[0]).join(", ")})`);
  });
  await section("Websites", async () => {
    const rows = rowsOf(await api.call("hosting_websites_list", { per_page: 100 }));
    if (!rows.length) console.log("  none");
    for (const w of rows) console.log(`  ${show(field(w, "domain"))}  type=${show(field(w, "website_type"))}  enabled=${show(field(w, "is_enabled"))}  order=${show(field(w, "order_id"))}`);
    if (rows[0]) console.log(`  (fields: ${Object.keys(rows[0]).join(", ")})`);
  });
  const vms = [];
  await section("VPS", async () => {
    const rows = rowsOf(await api.call("vps_virtual-machines_list"));
    if (!rows.length) console.log("  none");
    for (const v of rows) console.log(`  VM ${show(v.id)}  ${show(field(v, "plan"))}  state=${show(field(v, "state"))}  cpus=${show(field(v, "cpus"))}  memory=${show(field(v, "memory"))}  disk=${show(field(v, "disk"))}  os=${show(field(v, "template.name"))}  data_center=${show(field(v, "data_center_id"))}`);
    vms.push(...rows);
  });
  for (const vm of vms) {
    await section(`VPS ${vm.id}: Docker projects (Hostinger's Docker Manager)`, async () => {
      const projects = rowsOf(await api.call("vps_docker_list", { virtualMachineId: vm.id }));
      if (!projects.length) console.log("  none");
      for (const p of projects) {
        console.log(`  ${show(field(p, "name"))}  status=${show(field(p, "status", "state"))}`);
        for (const c of field(p, "containers") ?? []) console.log(`    ${show(field(c, "name"))}  ${show(field(c, "image"))}  ${show(field(c, "status", "state"))}  ports=${redact(JSON.stringify(field(c, "ports") ?? []))}`);
      }
      if (projects[0]) console.log(`  (fields: ${Object.keys(projects[0]).join(", ")})`);
    });
  }
  await section("VPS firewalls", async () => {
    const rows = rowsOf(await api.call("vps_firewall_list"));
    if (!rows.length) console.log("  none");
    for (const f of rows) console.log(`  ${show(field(f, "name"))}  synced=${show(field(f, "is_synced"))}  rules=${(field(f, "rules") ?? []).map((r) => `${show(r.action)} ${show(r.protocol)} ${show(r.port)}`).join(", ") || "-"}`);
  });
  await section("Domains", async () => {
    const rows = rowsOf(await api.call("domains_portfolio_list"));
    if (!rows.length) console.log("  none");
    for (const d of rows) console.log(`  ${show(field(d, "domain"))}  type=${show(field(d, "type"))}  status=${show(field(d, "status"))}`);
  });
  for (const zone of request.zones ?? []) {
    await section(`DNS zone ${zone}`, async () => {
      const rows = rowsOf(await api.call("dns_records_list", { domain: zone }));
      if (!rows.length) console.log("  no records here (the zone is not managed at Hostinger)");
      for (const r of rows) console.log(`  ${show(r.name)}  ${show(r.type)}`);
    });
  }
}

// ── Deploy ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// For testing this script: shorter pauses, and the site's address instead of https://<domain>.
const POLL_MS = Number(process.env.HOSTINGER_POLL_MS) || 15_000;
const siteUrl = (domain) => process.env.HOSTINGER_SITE_URL || `https://${domain}`;
/** Keeps a value out of the workflow log (GitHub masks it from here on). */
const mask = (value) => {
  if (process.env.GITHUB_ACTIONS && value) console.log(`::add-mask::${value}`);
  return value;
};

/** The first value under `key` anywhere in `value`. */
function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (key in value && value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = find(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The website's environment, from DEMO_DATABASE_URL: the owner connects as given (pooler host
 * and channel_binding taken out), the app as clinicmind_app with a password derived from it.
 */
function demoEnvironment(domain, reseed) {
  const raw = process.env.DEMO_DATABASE_URL?.trim();
  if (!raw) throw new Error("DEMO_DATABASE_URL is not set: add the database's connection string as a repository secret (docs/HOSTINGER.md).");
  mask(raw);
  const owner = new URL(raw);
  if (!/^postgres(ql)?:$/.test(owner.protocol)) throw new Error("DEMO_DATABASE_URL must be a postgresql:// connection string.");
  mask(decodeURIComponent(owner.password));
  owner.hostname = owner.hostname.replace("-pooler.", ".");
  owner.searchParams.delete("channel_binding");
  if (!owner.searchParams.has("sslmode")) owner.searchParams.set("sslmode", "require");
  const derive = (label, encoding = "hex", length = 40) => mask(createHmac("sha256", raw).update(`clinicmind:${label}`).digest(encoding).slice(0, length));
  const app = new URL(owner.toString());
  app.username = "clinicmind_app";
  app.password = derive("app-role");
  owner.searchParams.set("connection_limit", "5");
  app.searchParams.set("connection_limit", "10");
  const env = {
    APP_URL: `https://${domain}`,
    ROOT_DOMAIN: domain,
    DATABASE_URL: mask(app.toString()),
    SYSTEM_DATABASE_URL: mask(owner.toString()),
    AUTH_SECRET: derive("auth-secret", "base64url", 48),
    EMBED_SIGNING_SECRET: derive("embed-secret", "base64url", 48),
    CRON_SECRET: derive("cron-secret", "base64url", 48),
    SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD || "Demo-Clinic-2026!",
    TOKIO_WORKER_THREADS: "2",
    NEXT_BUILD_CPUS: "1",
    ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
    ...(reseed ? { RESEED_DEMO: "yes" } : {}),
  };
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

/** The website for `domain` on a Business or Cloud plan, created when it is not there yet. */
async function website(api, domain, create) {
  const exact = async () => rowsOf(await api.call("hosting_websites_list", { domain, per_page: 100 })).find((w) => w.domain === domain);
  const found = await exact();
  if (found) {
    console.log(`  ${domain}: there (type=${show(found.website_type)})`);
    return found;
  }
  if (!create) throw new Error(`There is no website ${domain} in the account.`);
  const orders = rowsOf(await api.call("hosting_orders_list"));
  const order = orders.find((o) => o.status === "active" && /business|cloud/i.test(String(field(o, "plan.name", "plan") ?? "")));
  if (!order) throw new Error("No active Business or Cloud hosting plan runs Node.js apps in this account.");
  console.log(`  ${domain}: creating it on order ${order.id} (${show(field(order, "plan.name", "plan"))})`);
  await api.call("hosting_websites_start-setup", { order_id: order.id, domain });
  for (let i = 0; i < 60; i++) {
    await sleep(POLL_MS);
    const setup = rowsOf(await api.call("hosting_websites_list-setups", { domain }))[0];
    const status = field(setup ?? {}, "status");
    console.log(`  setup: ${show(status)}`);
    if (status === "completed") break;
    if (status === "failed") throw new Error(`Setting up ${domain} failed: ${redact(JSON.stringify(setup))}`);
  }
  const created = await exact();
  if (!created) throw new Error(`${domain} did not appear in the websites list.`);
  return created;
}

/** The text of a build log (the `logs` of hosting_get-deployment), colour codes taken out. */
function logText(answer) {
  const logs = answer?.logs;
  const raw = typeof logs === "string" ? logs : (logs?.content ?? logs?.log ?? logs?.output ?? logs?.data ?? logs?.logs ?? "");
  const text = Array.isArray(raw) ? raw.map((l) => (typeof l === "string" ? l : (l?.message ?? l?.line ?? l?.content ?? JSON.stringify(l)))).join("\n") : String(raw ?? "");
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const printAnalysis = (analysis) => {
  if (analysis) console.log(`\nHostinger's analysis:\n${redact(typeof analysis === "string" ? analysis : JSON.stringify(analysis, null, 2))}`);
};

/** Follows a build until it is completed or failed, printing its log as it grows. */
async function followBuild(api, domain, buildUuid) {
  let fromLine = 0;
  let printed = 0;
  let state = "";
  let shownFields = false;
  const started = Date.now();
  while (Date.now() - started < 50 * 60_000) {
    const answer = await api.call("hosting_get-deployment", { domain, ...(buildUuid ? { buildUuid } : {}), fromLine });
    if (!shownFields && answer?.logs && typeof answer.logs === "object") {
      console.log(`  (log fields: ${Object.keys(answer.logs).join(", ")})`);
      shownFields = true;
    }
    const text = logText(answer);
    if (Number.isInteger(answer?.logs?.lines)) {
      // Each answer holds only the lines after fromLine.
      if (text.trim()) console.log(redact(text.replace(/\n+$/, "")));
      fromLine = answer.logs.lines;
    } else if (text.length > printed) {
      console.log(redact(text.slice(printed).replace(/\n+$/, "")));
      printed = text.length;
    }
    state = String(answer?.build?.state ?? "");
    if (/^(completed|failed|error|cancel)/i.test(state)) {
      printAnalysis(answer.analysis);
      return state;
    }
    await sleep(POLL_MS);
  }
  return state || "unknown (still running after 50 minutes)";
}

async function health(domain, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      // A site that is still starting can hold the request open: give up on it after 20 s.
      const res = await fetch(`${siteUrl(domain)}/api/health`, { headers: { "cache-control": "no-store" }, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (res.ok && body.includes('"service":"clinicmind"')) return `${res.status} ${body}`;
      console.log(`  ${siteUrl(domain)}/api/health → ${res.status}; trying again`);
    } catch (err) {
      console.log(`  ${siteUrl(domain)}/api/health → ${err instanceof Error ? err.cause?.code ?? err.message : err}; trying again`);
    }
    if (i < attempts - 1) await sleep(POLL_MS);
  }
  return `no healthy answer after ${attempts} tries`;
}

/** The app's newest log entries (`limit`) of the last `period`, optionally only some levels. */
async function runtimeLogs(api, username, domain, { period = "1h", limit = 80, levels } = {}) {
  const answer = await api.call("hosting_nodejs_runtime-logs", { username, domain, period, limit, ...(levels ? { levels } : {}) });
  const logs = Array.isArray(answer?.logs) ? answer.logs : [];
  if (!logs.length) return console.log("  (empty)");
  for (const l of logs) console.log(`  ${show(l.timestamp)} ${show(l.level)} ${redact(String(l.message ?? "")).slice(0, 400)}`);
}

/** The names in an environment variable list, whether it is rows of { key } or an object of them. */
function envNames(answer) {
  const rows = rowsOf(answer).length ? rowsOf(answer) : (find(answer, "env_vars") ?? find(answer, "variables"));
  if (Array.isArray(rows)) return rows.map((r) => (typeof r === "string" ? r : (r?.key ?? r?.name))).filter(Boolean);
  return answer && typeof answer === "object" ? Object.keys(answer) : [];
}

async function deploy(api, request) {
  const domain = request.domain;
  if (!domain) throw new Error('The request needs "domain".');
  const appDir = path.resolve(request.app ?? ".hostinger/app");
  const envVars = demoEnvironment(domain, Boolean(request.reseed));
  console.log("\n▶ Website");
  const site = await website(api, domain, request.create !== false);
  const username = site.username;
  console.log(`\n▶ Environment variables (${envVars.map((e) => e.key).join(", ")})`);
  await api.call("hosting_nodejs_replace-environment-variables", { username, domain, env_vars: envVars });
  console.log("\n▶ Upload and build");
  const started = await api.call("hosting_deploy", { domain, path: appDir, type: "nodejs", appType: "next", nodeVersion: request.nodeVersion ?? 22, buildScript: "build", outputDirectory: ".next" }, 20 * 60_000);
  const buildUuid = find(started, "buildUuid") ?? find(started, "build_uuid") ?? find(started, "uuid");
  console.log(`  build ${show(buildUuid)} started`);
  const state = await followBuild(api, domain, buildUuid);
  console.log(`\n▶ Build: ${state}`);
  if (!/^completed/i.test(state)) {
    process.exitCode = 1;
    return;
  }
  console.log("\n▶ Health check");
  console.log(`  ${await health(domain)}`);
  console.log("\n▶ The app's log (last hour)");
  await runtimeLogs(api, username, domain).catch((err) => console.log(`  could not read: ${redact(err.message)}`));
}

async function status(api, request) {
  const domain = request.domain;
  if (!domain) throw new Error('The request needs "domain".');
  const site = await website(api, domain, false);
  const username = site.username;
  if (request.restart) {
    await section("Restart the app (no rebuild)", async () => {
      console.log(`  ${redact(JSON.stringify(await api.call("hosting_nodejs_restart-application", { username, domain })))}`);
      await sleep(20_000);
    });
  }
  await section("Last build", async () => {
    const answer = await api.call("hosting_get-deployment", { domain });
    console.log(`  state=${show(answer?.build?.state)}  settings=${redact(JSON.stringify(answer?.buildSettings ?? null))}`);
    console.log(redact(logText(answer).split("\n").slice(-30).join("\n")));
    printAnalysis(answer?.analysis);
  });
  const period = request.logPeriod ?? "24h";
  await section(`The app's log (newest 60 entries of ${period})`, () => runtimeLogs(api, username, domain, { period, limit: 60 }));
  await section(`Errors and warnings (${period})`, () => runtimeLogs(api, username, domain, { period, limit: 40, levels: ["ERROR", "WARN"] }));
  await section("Environment variables (names only)", async () => {
    console.log(`  ${envNames(await api.call("hosting_nodejs_list-environment-variables", { username, domain })).join(", ") || "(none)"}`);
  });
  await section("SSL, CDN and cache", async () => {
    const settings = await api.call("hosting_websites_get-settings", { domain });
    console.log(`  ssl=${show(settings?.ssl?.status)}  https_redirect=${show(settings?.ssl?.is_https_redirect_enabled ?? settings?.ssl?.https_redirect)}  cdn=${show(settings?.cdn?.is_enabled)}  cache=${show(settings?.cache?.is_enabled)}`);
    if (settings?.ssl?.last_error ?? settings?.ssl?.error) console.log(`  ssl error: ${redact(JSON.stringify(settings.ssl.last_error ?? settings.ssl.error))}`);
    console.log(`  all settings: ${redact(JSON.stringify(settings)).slice(0, 1500)}`);
    console.log(`  CDN status: ${redact(JSON.stringify(await api.call("hosting_cdn_status", { username, domain }))).slice(0, 500)}`);
  });
  await section("From the internet", () => reachability(domain));
  await section("Health check", async () => console.log(`  ${await health(domain, 2)}`));
}

/** Where a request to the site stops: the name, plain HTTP, then HTTPS, 15 s each. */
async function reachability(domain) {
  try {
    const addresses = await lookup(domain, { all: true });
    console.log(`  DNS: ${addresses.length} address${addresses.length === 1 ? "" : "es"} (${addresses.map((a) => `IPv${a.family}`).join(", ")})`);
  } catch (err) {
    console.log(`  DNS: ${err.code ?? err.message}`);
    return;
  }
  for (const url of [`http://${domain}/api/health`, `https://${domain}/api/health`]) {
    const started = Date.now();
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const location = res.headers.get("location");
      console.log(`  ${url} → ${res.status}${location ? ` → ${location}` : ""} in ${Date.now() - started} ms (server: ${show(res.headers.get("server"))})`);
    } catch (err) {
      console.log(`  ${url} → ${err?.name === "TimeoutError" ? "no answer in 15 s" : (err?.cause?.code ?? err?.message ?? err)}`);
    }
  }
}

const ACTIONS = { inventory, deploy, status };

async function main() {
  const file = process.argv[2] ?? "deploy/hostinger/request.json";
  const request = JSON.parse(readFileSync(file, "utf8"));
  const action = ACTIONS[request.action];
  if (!action) throw new Error(`Unknown action "${request.action}" in ${file}: one of ${Object.keys(ACTIONS).join(", ")}`);
  const api = new HostingerApi();
  try {
    await api.start();
    await action(api, request);
  } catch (err) {
    console.error(`\n✗ ${redact(err instanceof Error ? err.message : err)}`);
    const log = api.recentLog();
    if (log.trim()) console.error(`\nHostinger API server log (last lines):\n${redact(log)}`);
    process.exitCode = 1;
  } finally {
    api.stop();
  }
}

await main();
