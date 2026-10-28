"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { LEAD_SORTS, LEAD_SOURCES, LEAD_STAGES, SOURCE_LABELS, STAGE_LABELS } from "@/modules/crm/shared";
import { LEAD_FILTER_KEYS, leadsHref, type CampaignOption, type LeadQueryState, type StaffOption, type TreatmentOption } from "./lead-shared";

const SORT_LABELS: Record<(typeof LEAD_SORTS)[number], string> = { newest: "Newest first", lastContact: "Last contact", oldest: "Oldest first" };

/**
 * The filter bar of the pipeline and the list. Every control rewrites the
 * URL and the server page re-reads it; nothing is filtered in the browser.
 * Below 768 px the selects fold behind a "Filters" button.
 */
export function LeadFilters({
  tab,
  query,
  staff,
  treatments,
  campaigns,
}: {
  tab: "pipeline" | "list";
  query: LeadQueryState;
  staff: StaffOption[];
  treatments: TreatmentOption[];
  campaigns: CampaignOption[];
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(query.q ?? "");

  const navigate = (next: LeadQueryState) => router.replace(leadsHref(tab, { ...next, page: undefined }), { scroll: false });
  const set = (key: keyof LeadQueryState, value: string) => navigate({ ...query, [key]: value || undefined });
  const active = LEAD_FILTER_KEYS.filter((k) => (tab === "pipeline" && k === "stage" ? false : Boolean(query[k])));

  function onSearch(e: FormEvent) {
    e.preventDefault();
    navigate({ ...query, q: q.trim() || undefined });
  }

  const select = (key: keyof LeadQueryState, label: string, any: string, options: { value: string; label: string }[]) => (
    <Field label={label} htmlFor={`${id}-${key}`}>
      <Select id={`${id}-${key}`} value={String(query[key] ?? "")} onChange={(e) => set(key, e.target.value)}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <div className="space-y-3 border-b border-border p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <form onSubmit={onSearch} role="search" className="flex w-full max-w-md items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Search" htmlFor={`${id}-q`}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id={`${id}-q`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or e-mail" className="pl-9" />
              </div>
            </Field>
          </div>
          <Button type="submit" variant="outline" size="lg">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-2">
          {tab === "list" ? (
            <Field label="Sort" htmlFor={`${id}-sort`}>
              <Select id={`${id}-sort`} value={query.sort ?? "newest"} onChange={(e) => set("sort", e.target.value)} className="w-44">
                {LEAD_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Button type="button" variant="outline" size="lg" className="md:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${id}-panel`}>
            <Filter className="h-4 w-4" />
            Filters
            {active.length ? <Badge tone="accent">{active.length}</Badge> : null}
          </Button>
          {active.length ? (
            <Button type="button" variant="ghost" size="lg" onClick={() => { setQ(""); navigate({ sort: query.sort }); }}>
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>
      <div id={`${id}-panel`} className={cn("grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid md:grid-cols-4 xl:grid-cols-7", open ? "grid" : "hidden")}>
        {tab === "list" ? select("stage", "Stage", "Any stage", LEAD_STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))) : null}
        {select("source", "Source", "Any source", LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] })))}
        {select("ownerId", "Owner", "Anyone", staff.map((s) => ({ value: s.id, label: s.fullName })))}
        {select("interest", "Interest", "Any treatment", treatments.map((t) => ({ value: t.key, label: t.name })))}
        {select("campaignId", "Campaign", "Any campaign", campaigns.map((c) => ({ value: c.id, label: c.name })))}
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
