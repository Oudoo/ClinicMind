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
//
// The repository is public, so its workflow logs are too: this prints plan names, states and
// domain names, never account user names, IP addresses, e-mail addresses or secret values.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

  /** One tool of the server: its JSON answer, or an error with the server's explanation. */
  async call(name, args = {}, timeoutMs) {
    const result = await this.#request("tools/call", { name, arguments: args }, timeoutMs);
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain text answer
    }
    if (result?.isError) throw new Error(`${name}: ${typeof data === "string" ? data : JSON.stringify(data)}`.slice(0, 2000));
    return data;
  }
}

/** Text for the public log: hosting user names, e-mail and IP addresses masked. */
const redact = (text) =>
  String(text)
    .replace(/\bu\d{5,}\b/g, "u…")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "…@…")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "…ip…");

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
  await section("VPS", async () => {
    const rows = rowsOf(await api.call("vps_virtual-machines_list"));
    if (!rows.length) console.log("  none");
    for (const v of rows) console.log(`  VM ${show(v.id)}  ${show(field(v, "plan"))}  state=${show(field(v, "state"))}  cpus=${show(field(v, "cpus"))}  memory=${show(field(v, "memory"))}  os=${show(field(v, "template.name"))}`);
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

const ACTIONS = { inventory };

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
