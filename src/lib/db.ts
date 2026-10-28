import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { PrismaClient } from "@prisma/client";

/**
 * Database access under row-level security.
 *
 * Every table that holds a clinic's rows has a policy `"tenantId" =
 * app_current_tenant()` (see the RLS migration). Policies bind every role
 * except the tables' owner and superusers, so in production the application
 * connects as the role `clinicmind_app` (DATABASE_URL) and:
 *
 *  - `db` follows the request. Where the request's clinic is known it runs on
 *    that clinic's own connection pool, whose connections carry
 *    `app.current_tenant`; anywhere else it runs on connections with no clinic
 *    set, which see none of any clinic's rows. A query that forgets its
 *    `tenantId` filter therefore can never return another clinic's rows, and a
 *    write into another clinic is refused by the database.
 *  - `systemDb` is for the few paths that work across clinics on purpose:
 *    signing in, resolving a session, a token or a webhook to its clinic, the
 *    audit log writer, the platform console, background jobs and scripts. It
 *    connects with SYSTEM_DATABASE_URL (the owner role, which the policies do
 *    not bind) and falls back to DATABASE_URL.
 *
 * A request's clinic comes from `getActingContext()` (staff and embed
 * sessions), `withTenant()` (a public link or webhook once resolved to its
 * clinic) or `withSystem()` (jobs and scripts). With DATABASE_URL pointing at
 * the owner (local development) nothing is enforced and everything behaves as
 * before; `/api/health` reports which applies.
 */

interface Scope {
  tenantId: string | null;
  system: boolean;
}

interface Pool {
  client: PrismaClient;
  lastUsed: number;
}

const LOG: ("warn" | "error")[] = process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"];
/** Tenant ids become a connection option: only the characters a cuid or slug can hold. */
const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Connections per clinic pool, and how many clinic pools stay open: past that,
 * pools idle for IDLE_MS are closed first (a soft cap: busy pools stay). The
 * defaults keep 3 × 20 well inside Postgres's default 100 connections.
 */
const POOL_SIZE = Math.max(1, Number(process.env.DB_TENANT_POOL_SIZE ?? 3) || 3);
const MAX_POOLS = Math.max(1, Number(process.env.DB_TENANT_POOLS ?? 20) || 20);
const IDLE_MS = 5 * 60_000;

interface DbState {
  store: AsyncLocalStorage<Scope>;
  pools: Map<string, Pool>;
  none?: PrismaClient;
  system?: PrismaClient;
}

// One per process, surviving dev-server module reloads.
const globalState = globalThis as unknown as { __clinicmindDb?: DbState };
const state: DbState = (globalState.__clinicmindDb ??= { store: new AsyncLocalStorage<Scope>(), pools: new Map() });

/** `url` with one more connection argument (percent-encoded, which Prisma's URL parser expects). */
function withParam(url: string, key: string, value: string, replace = false): string {
  const [base, query = ""] = url.split("?") as [string, string?];
  const params = query.split("&").filter(Boolean);
  const existing = params.findIndex((p) => p.split("=")[0] === key);
  if (existing >= 0) {
    if (!replace) {
      const current = decodeURIComponent(params[existing]!.slice(key.length + 1));
      params[existing] = `${key}=${encodeURIComponent(`${current} ${value}`.trim())}`;
    } else {
      params[existing] = `${key}=${encodeURIComponent(value)}`;
    }
  } else {
    params.push(`${key}=${encodeURIComponent(value)}`);
  }
  return `${base}?${params.join("&")}`;
}

function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/** The connection string of one clinic's pool: the clinic travels as a startup option. */
export function tenantDatabaseUrl(tenantId: string, url: string = baseUrl()): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant id for a database connection");
  const withTenant = withParam(url, "options", `-c app.current_tenant=${tenantId}`);
  return withParam(withTenant, "connection_limit", String(POOL_SIZE), true);
}

function noTenantClient(): PrismaClient {
  return (state.none ??= new PrismaClient({ log: LOG }));
}

function systemClient(): PrismaClient {
  return (state.system ??= new PrismaClient({ log: LOG, datasourceUrl: process.env.SYSTEM_DATABASE_URL || baseUrl() }));
}

function tenantClient(tenantId: string): PrismaClient {
  let pool = state.pools.get(tenantId);
  if (!pool) {
    closeIdlePools();
    pool = { client: new PrismaClient({ log: LOG, datasourceUrl: tenantDatabaseUrl(tenantId) }), lastUsed: Date.now() };
    state.pools.set(tenantId, pool);
  }
  pool.lastUsed = Date.now();
  return pool.client;
}

/** Above MAX_POOLS, close the pools of clinics idle for a while (never one a request is using). */
function closeIdlePools(): void {
  if (state.pools.size < MAX_POOLS) return;
  const now = Date.now();
  const idle = [...state.pools.entries()].filter(([, p]) => now - p.lastUsed > IDLE_MS).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [tenantId, pool] of idle.slice(0, state.pools.size - MAX_POOLS + 1)) {
    state.pools.delete(tenantId);
    void pool.client.$disconnect().catch(() => undefined);
  }
}

/**
 * One scope object per React server render, so components that load their own
 * data inside a page see the clinic the page's `getActingContext()` resolved.
 * Outside a render (route handlers, jobs, tests) every call returns a new,
 * empty object.
 */
const renderScope = cache((): Scope => ({ tenantId: null, system: false }));

function currentScope(): Scope | undefined {
  const explicit = state.store.getStore();
  if (explicit && (explicit.system || explicit.tenantId)) return explicit;
  const render = renderScope();
  if (render.system || render.tenantId) return render;
  return explicit;
}

function clientFor(scope: Scope | undefined): PrismaClient {
  if (scope?.system) return systemClient();
  if (scope?.tenantId) return tenantClient(scope.tenantId);
  return noTenantClient();
}

/** The client of the current scope (for code that must hand a concrete client on). */
export function currentDb(): PrismaClient {
  return clientFor(currentScope());
}

/** Database access in the current request's clinic (see above). */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = currentDb();
    const value: unknown = Reflect.get(client, prop, client);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});

/** Cross-clinic access, on purpose and only where the comment at the call says why. */
export const systemDb: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = systemClient();
    const value: unknown = Reflect.get(client, prop, client);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});

/** Run `fn` with `db` scoped to one clinic (a public link or a webhook once resolved to its clinic). */
export function withTenant<T>(tenantId: string, fn: () => T): T {
  return state.store.run({ tenantId, system: false }, fn);
}

/** Run `fn` with `db` able to reach every clinic (background jobs, scripts, the seed). */
export function withSystem<T>(fn: () => T): T {
  return state.store.run({ tenantId: null, system: true }, fn);
}

/**
 * Run `fn` outside any scope, as an anonymous visitor's request runs: `db`
 * sees no clinic's rows until something (a token resolved with
 * `withTenant`, a session) sets one. Tests call public routes through it.
 */
export function withoutScope<T>(fn: () => T): T {
  return state.store.exit(fn);
}

/**
 * The rest of the current execution (and what it starts) runs in the system
 * scope. For test files that call services directly across clinics (see
 * `runAsSystem` in src/test/db.ts); application code uses `withSystem`.
 */
export function enterSystemScope(): void {
  state.store.enterWith({ tenantId: null, system: true });
}

/**
 * `fn` bound to the database scope it was created in, for a callback that
 * something else calls later, outside the request (a response stream's
 * `pull`). Created outside any scope, it sees no clinic's rows.
 */
export function bindScope<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const scope = currentScope() ?? { tenantId: null, system: false };
  return (...args) => state.store.run(scope, () => fn(...args));
}

/**
 * A fresh scope for the rest of this request, entered by `getActingContext()`
 * before it reads anything: until the session resolves (and for a caller
 * without one), `db` sees no clinic's rows.
 */
export function enterRequestScope(): Scope {
  const scope: Scope = { tenantId: null, system: false };
  state.store.enterWith(scope);
  return scope;
}

/** The session resolved: the request (and the server render it belongs to) acts for this clinic. */
export function setRequestTenant(scope: Scope, tenantId: string | null): void {
  scope.tenantId = tenantId;
  if (tenantId) renderScope().tenantId = tenantId;
}

export interface RlsStatus {
  enforced: boolean;
  role: string;
  reason: string | null;
  systemCanReachAllClinics: boolean;
}

/**
 * Whether the policies bind the application's connection: not a superuser,
 * no BYPASSRLS, and not the owner of the clinic tables.
 */
export async function rlsStatus(): Promise<RlsStatus> {
  const check = async (client: PrismaClient) => {
    const [row] = await client.$queryRaw<{ role: string; superuser: boolean; bypass: boolean; owner: string | null }[]>`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
             (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'patients') AS owner
      FROM pg_roles r WHERE r.rolname = current_user`;
    return row!;
  };
  const app = await check(noTenantClient());
  const system = await check(systemClient());
  const reason = app.superuser
    ? "the application connects as a superuser"
    : app.bypass
      ? "the application role has BYPASSRLS"
      : app.owner === app.role
        ? "the application connects as the owner of the tables"
        : null;
  return {
    enforced: reason === null,
    role: app.role,
    reason,
    systemCanReachAllClinics: system.superuser || system.bypass || system.owner === system.role,
  };
}

/**
 * Soft-delete helper: standard filter to exclude archived rows. Domain services
 * spread this into their `where` clauses so deleted data stays out of queries
 * without losing history.
 */
export const notDeleted = { deletedAt: null } as const;
