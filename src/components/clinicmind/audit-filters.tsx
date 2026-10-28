"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { ACTION_GROUPS, AUDIT_FILTER_KEYS, auditHref, type AuditQuery } from "@/modules/audit/query";
import { PatientPicker } from "./appointment-patient-picker";

/**
 * The audit log's filter bar. Every control rewrites the URL and the server
 * page re-reads it; nothing is filtered in the browser. Below 768 px the
 * filters fold behind a "Filters" button.
 */
export function AuditFilters({
  query,
  people,
  patient,
}: {
  query: AuditQuery;
  people: { value: string; label: string }[];
  /** The patient named by `query.patient`, when it exists. */
  patient: { id: string; fullName: string } | null;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(query.q ?? "");

  const navigate = (next: AuditQuery) => router.replace(auditHref({ ...next, page: undefined }), { scroll: false });
  const set = (key: keyof AuditQuery, value: string) => navigate({ ...query, [key]: value || undefined });
  const active = AUDIT_FILTER_KEYS.filter((k) => k !== "q" && Boolean(query[k]));
  // An exact action code (from a link) that is not one of the groups still shows in the select.
  const exactAction = query.action && !ACTION_GROUPS.some((g) => g.key === query.action) ? query.action : null;

  function onSearch(e: FormEvent) {
    e.preventDefault();
    navigate({ ...query, q: q.trim() || undefined });
  }

  return (
    <div className="space-y-3 border-b border-border p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <form onSubmit={onSearch} role="search" className="flex w-full max-w-md items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Search" htmlFor={`${id}-q`}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id={`${id}-q`}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Action, record ID, e-mail or IP"
                  className="pl-9"
                />
              </div>
            </Field>
          </div>
          <Button type="submit" variant="outline" size="lg">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="md:hidden"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={`${id}-panel`}
          >
            <Filter className="h-4 w-4" />
            Filters
            {active.length ? <Badge tone="accent">{active.length}</Badge> : null}
          </Button>
          {active.length || query.q ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => {
                setQ("");
                navigate({});
              }}
            >
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <div
        id={`${id}-panel`}
        className={cn("grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid md:grid-cols-3 xl:grid-cols-5", open ? "grid" : "hidden")}
      >
        <Field label="Person" htmlFor={`${id}-actor`}>
          <Select id={`${id}-actor`} value={query.actor ?? ""} onChange={(e) => set("actor", e.target.value)}>
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <PatientPicker
          value={patient ?? (query.patient ? { id: query.patient, fullName: "Unknown patient" } : null)}
          onChange={(p) => set("patient", p?.id ?? "")}
        />
        <Field label="Activity" htmlFor={`${id}-action`}>
          <Select id={`${id}-action`} value={query.action ?? ""} onChange={(e) => set("action", e.target.value)}>
            <option value="">Everything</option>
            {exactAction ? <option value={exactAction}>{exactAction}</option> : null}
            {ACTION_GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" htmlFor={`${id}-from`}>
          <Input id={`${id}-from`} type="date" value={query.from ?? ""} max={query.to || undefined} onChange={(e) => set("from", e.target.value)} />
        </Field>
        <Field label="To" htmlFor={`${id}-to`}>
          <Input id={`${id}-to`} type="date" value={query.to ?? ""} min={query.from || undefined} onChange={(e) => set("to", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
