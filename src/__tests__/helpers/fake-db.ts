/**
 * Minimal in-memory stand-in for the Prisma client, for route-level tests.
 *
 * It implements the subset of the Prisma query API the application uses
 * (findFirst/findUnique/findMany/count/create/update/upsert/delete, nested
 * `create`, relation `include`/`select`, `_count`, `$transaction`) with real
 * `where` semantics (equality, null, in/notIn/not, lt/lte/gt/gte, contains,
 * OR/AND/NOT, relation filters). Tests seed it with rows for two tenants and
 * assert on what the routes read and write.
 */
export type Row = Record<string, any>;

interface RelationDef {
  model: string;
  single: boolean;
  /** Column on this model pointing at the related row's id. */
  localKey?: string;
  /** Column on the related model pointing at this row's id. */
  foreignKey?: string;
}

const RELATIONS: Record<string, Record<string, RelationDef>> = {
  tenant: {
    embed: { model: "tenantEmbedConfig", single: true, foreignKey: "tenantId" },
    clinics: { model: "clinic", single: false, foreignKey: "tenantId" },
    users: { model: "user", single: false, foreignKey: "tenantId" },
    patients: { model: "patient", single: false, foreignKey: "tenantId" },
  },
  tenantEmbedConfig: { tenant: { model: "tenant", single: true, localKey: "tenantId" } },
  user: { tenant: { model: "tenant", single: true, localKey: "tenantId" } },
  clinic: { tenant: { model: "tenant", single: true, localKey: "tenantId" } },
  patient: {
    tenant: { model: "tenant", single: true, localKey: "tenantId" },
    medicalHistory: { model: "medicalHistory", single: true, foreignKey: "patientId" },
    medications: { model: "medication", single: false, foreignKey: "patientId" },
    appointments: { model: "appointment", single: false, foreignKey: "patientId" },
    visits: { model: "visit", single: false, foreignKey: "patientId" },
    timeline: { model: "timelineEvent", single: false, foreignKey: "patientId" },
  },
  medicalHistory: { patient: { model: "patient", single: true, localKey: "patientId" } },
  medication: { patient: { model: "patient", single: true, localKey: "patientId" } },
  appointment: { patient: { model: "patient", single: true, localKey: "patientId" } },
  consultation: { patient: { model: "patient", single: true, localKey: "patientId" } },
  visit: { patient: { model: "patient", single: true, localKey: "patientId" } },
  conversation: {
    patient: { model: "patient", single: true, localKey: "patientId" },
    messages: { model: "message", single: false, foreignKey: "conversationId" },
  },
};

const OPERATORS = new Set(["equals", "in", "notIn", "not", "lt", "lte", "gt", "gte", "contains", "mode", "startsWith", "endsWith"]);

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function matchesScalar(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (isPlainObject(cond)) {
    if ("equals" in cond && !matchesScalar(value, cond.equals)) return false;
    if ("in" in cond && !(cond.in as any[]).some((v) => matchesScalar(value, v))) return false;
    if ("notIn" in cond && (cond.notIn as any[]).some((v) => matchesScalar(value, v))) return false;
    if ("not" in cond && matchesScalar(value, cond.not)) return false;
    if ("lt" in cond && !(value < cond.lt)) return false;
    if ("lte" in cond && !(value <= cond.lte)) return false;
    if ("gt" in cond && !(value > cond.gt)) return false;
    if ("gte" in cond && !(value >= cond.gte)) return false;
    if ("contains" in cond) {
      const insensitive = cond.mode === "insensitive";
      const hay = insensitive ? String(value ?? "").toLowerCase() : String(value ?? "");
      const needle = insensitive ? String(cond.contains).toLowerCase() : String(cond.contains);
      if (!hay.includes(needle)) return false;
    }
    return true;
  }
  return value === cond;
}

export function createFakeDb(initial: Record<string, Row[]> = {}) {
  const store = new Map<string, Row[]>();
  let seq = 0;

  const tables = (model: string): Row[] => {
    let rows = store.get(model);
    if (!rows) {
      rows = [];
      store.set(model, rows);
    }
    return rows;
  };

  function resolveSingle(rel: RelationDef, row: Row): Row | null {
    if (rel.localKey) {
      const id = row[rel.localKey];
      return id == null ? null : (tables(rel.model).find((r) => r.id === id) ?? null);
    }
    return tables(rel.model).find((r) => r[rel.foreignKey!] === row.id) ?? null;
  }

  function resolveMany(rel: RelationDef, row: Row): Row[] {
    return tables(rel.model).filter((r) => r[rel.foreignKey!] === row.id);
  }

  function matches(model: string, row: Row, where: Record<string, any> | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "OR") {
        if (!(cond as Record<string, any>[]).some((c) => matches(model, row, c))) return false;
        continue;
      }
      if (key === "AND") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((c) => matches(model, row, c))) return false;
        continue;
      }
      if (key === "NOT") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((c) => matches(model, row, c))) return false;
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (rel && isPlainObject(cond) && !Object.keys(cond).some((k) => OPERATORS.has(k))) {
        if (rel.single) {
          const related = resolveSingle(rel, row);
          if (!related || !matches(rel.model, related, cond)) return false;
        } else {
          const related = resolveMany(rel, row);
          if ("some" in cond && !related.some((r) => matches(rel.model, r, cond.some))) return false;
          if ("none" in cond && related.some((r) => matches(rel.model, r, cond.none))) return false;
          if ("every" in cond && !related.every((r) => matches(rel.model, r, cond.every))) return false;
        }
        continue;
      }
      if (!matchesScalar(row[key], cond)) return false;
    }
    return true;
  }

  /** Prisma compound-unique syntax `{ tenantId_email: { tenantId, email } }` → flat. */
  function unwrapUnique(where: Record<string, any> | undefined): Record<string, any> | undefined {
    if (!where) return where;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && isPlainObject(v) && !Object.keys(v).some((kk) => OPERATORS.has(kk))) {
        Object.assign(out, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** Apply `include` / `select` the way Prisma does: `select` projects, `include` adds. */
  function withRelations(model: string, row: Row, args: any): Row {
    const spec = { ...(args?.include ?? {}), ...(args?.select ?? {}) };
    const out: Row = args?.select ? {} : { ...row };
    for (const [key, value] of Object.entries(spec)) {
      if (!value) continue;
      if (args?.select && !RELATIONS[model]?.[key] && key !== "_count") {
        out[key] = row[key];
        continue;
      }
      if (key === "_count") {
        const counts: Row = {};
        for (const relKey of Object.keys((value as any).select ?? {})) {
          const rel = RELATIONS[model]?.[relKey];
          counts[relKey] = rel ? resolveMany(rel, row).length : 0;
        }
        out._count = counts;
        continue;
      }
      const rel = RELATIONS[model]?.[key];
      if (!rel) continue;
      const nested = isPlainObject(value) ? value : undefined;
      if (rel.single) {
        const related = resolveSingle(rel, row);
        out[key] = related ? withRelations(rel.model, related, nested) : null;
      } else {
        out[key] = resolveMany(rel, row)
          .filter((r) => matches(rel.model, r, nested?.where))
          .map((r) => withRelations(rel.model, r, nested));
      }
    }
    return out;
  }

  function createRow(model: string, data: Row): Row {
    const now = new Date();
    const row: Row = { id: `${model}_${++seq}`, createdAt: now, updatedAt: now, deletedAt: null };
    const nested: [string, RelationDef, any][] = [];
    for (const [key, value] of Object.entries(data)) {
      const rel = RELATIONS[model]?.[key];
      if (rel && isPlainObject(value) && ("create" in value || "connect" in value)) {
        nested.push([key, rel, value]);
        continue;
      }
      row[key] = value;
    }
    tables(model).push(row);
    for (const [, rel, value] of nested) {
      if (value.connect && rel.localKey) row[rel.localKey] = value.connect.id;
      if (value.create) {
        const items = Array.isArray(value.create) ? value.create : [value.create];
        for (const item of items) createRow(rel.model, { ...item, [rel.foreignKey!]: row.id });
      }
    }
    return row;
  }

  function sortRows(rows: Row[], orderBy: any): Row[] {
    const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean);
    if (!clauses.length) return rows;
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const [field, dir] = Object.entries(clause)[0] as [string, string];
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  function delegate(model: string) {
    const find = (where: Record<string, any> | undefined) =>
      tables(model).find((r) => matches(model, r, where)) ?? null;
    return {
      findFirst: async (args: any = {}) => {
        const row = find(args.where);
        return row ? withRelations(model, row, args) : null;
      },
      findUnique: async (args: any = {}) => {
        const row = find(unwrapUnique(args.where));
        return row ? withRelations(model, row, args) : null;
      },
      findMany: async (args: any = {}) => {
        let rows = tables(model).filter((r) => matches(model, r, args.where));
        rows = sortRows(rows, args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take != null) rows = rows.slice(0, args.take);
        return rows.map((r) => withRelations(model, r, args));
      },
      count: async (args: any = {}) => tables(model).filter((r) => matches(model, r, args.where)).length,
      create: async (args: any) => withRelations(model, createRow(model, args.data), args),
      update: async (args: any) => {
        const row = find(unwrapUnique(args.where));
        if (!row) throw new Error(`fake-db: ${model}.update matched no row`);
        Object.assign(row, args.data, { updatedAt: new Date() });
        return withRelations(model, row, args);
      },
      upsert: async (args: any) => {
        const row = find(unwrapUnique(args.where));
        if (row) {
          Object.assign(row, args.update, { updatedAt: new Date() });
          return withRelations(model, row, args);
        }
        return withRelations(model, createRow(model, args.create), args);
      },
      delete: async (args: any) => {
        const rows = tables(model);
        const idx = rows.findIndex((r) => matches(model, r, unwrapUnique(args.where)));
        if (idx === -1) throw new Error(`fake-db: ${model}.delete matched no row`);
        return rows.splice(idx, 1)[0];
      },
    };
  }

  const delegates = new Map<string, ReturnType<typeof delegate>>();

  const db: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "$transaction") {
          return async (arg: any) => (typeof arg === "function" ? arg(db) : Promise.all(arg));
        }
        if (prop.startsWith("$")) return async () => undefined;
        let d = delegates.get(prop);
        if (!d) {
          d = delegate(prop);
          delegates.set(prop, d);
        }
        return d;
      },
    },
  );

  const api = {
    /** The Prisma-shaped client. */
    db,
    /** Live rows of a model (mutable, for assertions). */
    rows: (model: string): Row[] => tables(model),
    /** Insert rows verbatim (ids and all). */
    seed(model: string, rows: Row[]) {
      for (const row of rows) tables(model).push({ deletedAt: null, ...row });
    },
    /** Drop every row. */
    reset() {
      store.clear();
      seq = 0;
    },
  };

  for (const [model, rows] of Object.entries(initial)) api.seed(model, rows);
  return api;
}

export type FakeDb = ReturnType<typeof createFakeDb>;

/**
 * Shared instance for tests that `vi.mock("@/lib/db")` — the mock factory and
 * the test file both import this module, so they see the same store.
 */
export const fake = createFakeDb();

/**
 * What `vi.mock("@/lib/db")` returns: the in-memory store behind both clients
 * and pass-through scopes (the fake has no row-level security to scope).
 */
export function fakeDbModule() {
  return {
    db: fake.db,
    systemDb: fake.db,
    currentDb: () => fake.db,
    withTenant: <T>(_tenantId: string, fn: () => T): T => fn(),
    withSystem: <T>(fn: () => T): T => fn(),
    bindScope: <F>(fn: F): F => fn,
    enterRequestScope: () => ({ tenantId: null, system: false }),
    enterSystemScope: () => undefined,
    withoutScope: <T>(fn: () => T): T => fn(),
    setRequestTenant: () => undefined,
    notDeleted: { deletedAt: null },
  };
}
