"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Download, Filter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  AGE_BANDS,
  ARCHIVED_OPTIONS,
  DEFAULT_SORT,
  GENDER_OPTIONS,
  LANGUAGE_OPTIONS,
  QUICK_VIEWS,
  REGISTERED_WINDOWS,
  SORT_OPTIONS,
  SOURCE_OPTIONS,
  UPCOMING_OPTIONS,
  VISIT_WINDOWS,
  hasPatientFilters,
  matchesQuickView,
  patientFilterChips,
  patientListHref,
  patientQueryParams,
  withoutFilter,
  type PatientFilterKey,
  type PatientListQuery,
} from "@/modules/patients/filters";
import { PatientSavedViews, type SavedViewDTO } from "@/components/clinicmind/patient-filters-views";

export interface DoctorOption {
  id: string;
  fullName: string;
}

/**
 * The patient list's filter bar. Every control writes the URL (router.replace)
 * and the server page re-renders the list; nothing is filtered client-side.
 * Below 768 px the controls collapse behind a "Filters" button, and the active
 * filters stay visible as chips with an X.
 */
export function PatientFilters({
  query,
  total,
  doctors,
  tags,
  views,
  canSaveViews,
}: {
  query: PatientListQuery;
  total: number;
  doctors: DoctorOption[];
  tags: { tag: string; count: number }[];
  views: SavedViewDTO[];
  canSaveViews: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);

  const navigate = (next: PatientListQuery) => router.replace(patientListHref(next), { scroll: false });
  const set = <K extends keyof PatientListQuery>(key: K, value: PatientListQuery[K]) => {
    const next: PatientListQuery = { ...query, page: undefined, [key]: value || undefined };
    if (key === "reg" && value !== "custom") {
      delete next.from;
      delete next.to;
    }
    navigate(next);
  };

  const chips = patientFilterChips(query, { doctorName: (d) => doctors.find((x) => x.id === d)?.fullName });
  const filtered = hasPatientFilters(query);
  const exportHref = `/api/patients/export?${patientQueryParams({ ...query, page: undefined }).toString()}`;
  const tagOptions = query.tag && !tags.some((t) => t.tag === query.tag) ? [{ tag: query.tag, count: 0 }, ...tags] : tags;

  return (
    <div className="space-y-3 border-b border-border p-4">
      {/* Quick views */}
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Quick views">
        <span className="data-label mr-1">Quick views</span>
        {QUICK_VIEWS.map((view) => {
          const active = matchesQuickView(query, view.query);
          return (
            <button
              key={view.key}
              type="button"
              onClick={() => navigate(active ? { sort: query.sort } : { ...view.query, sort: query.sort })}
              aria-pressed={active}
              className={cn(
                "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                active
                  ? "border-accent bg-accent-muted text-accent"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {view.label}
            </button>
          );
        })}
        {canSaveViews ? <PatientSavedViews query={query} views={views} onApply={navigate} /> : null}
      </div>

      {/* Search + toggles */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <SearchBox key={query.q ?? ""} initial={query.q ?? ""} onSearch={(q) => set("q", q)} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Sort" htmlFor={`${id}-sort`}>
            <Select
              id={`${id}-sort`}
              value={query.sort ?? DEFAULT_SORT}
              onChange={(e) => navigate({ ...query, page: undefined, sort: e.target.value as PatientListQuery["sort"] })}
              className="w-56"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
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
            {chips.length ? <Badge tone="accent">{chips.length}</Badge> : null}
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href={exportHref} download title="Export the filtered list as CSV (UTF-8, opens in Excel)">
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      {/* Filter controls: always on desktop, behind the toggle on phones */}
      <div id={`${id}-panel`} className={cn("grid-cols-2 gap-3 md:grid md:grid-cols-3 lg:grid-cols-5", open ? "grid" : "hidden")}>
        <FilterSelect id={`${id}-gender`} label="Gender" value={query.gender ?? ""} onChange={(v) => set("gender", v as PatientListQuery["gender"])} options={GENDER_OPTIONS} any="Any gender" />
        <FilterSelect id={`${id}-age`} label="Age band" value={query.age ?? ""} onChange={(v) => set("age", v as PatientListQuery["age"])} options={AGE_BANDS} any="Any age" />
        <FilterSelect
          id={`${id}-tag`}
          label="Tag"
          value={query.tag ?? ""}
          onChange={(v) => set("tag", v)}
          options={tagOptions.map((t) => ({ key: t.tag, label: t.count ? `${t.tag} (${t.count})` : t.tag }))}
          any="Any tag"
        />
        <FilterSelect
          id={`${id}-doctor`}
          label="Doctor"
          value={query.doctor ?? ""}
          onChange={(v) => set("doctor", v)}
          options={doctors.map((d) => ({ key: d.id, label: d.fullName }))}
          any="Any doctor"
        />
        <FilterSelect id={`${id}-upcoming`} label="Upcoming appointment" value={query.upcoming ?? ""} onChange={(v) => set("upcoming", v as PatientListQuery["upcoming"])} options={UPCOMING_OPTIONS} any="Any" />
        <FilterSelect id={`${id}-visit`} label="Last visit" value={query.visit ?? ""} onChange={(v) => set("visit", v as PatientListQuery["visit"])} options={VISIT_WINDOWS} any="Any time" />
        <FilterSelect id={`${id}-reg`} label="Registered" value={query.reg ?? ""} onChange={(v) => set("reg", v as PatientListQuery["reg"])} options={REGISTERED_WINDOWS} any="Any time" />
        {query.reg === "custom" ? (
          <>
            <Field label="From" htmlFor={`${id}-from`}>
              <Input id={`${id}-from`} type="date" value={query.from ?? ""} onChange={(e) => set("from", e.target.value)} />
            </Field>
            <Field label="To" htmlFor={`${id}-to`}>
              <Input id={`${id}-to`} type="date" value={query.to ?? ""} onChange={(e) => set("to", e.target.value)} />
            </Field>
          </>
        ) : null}
        <FilterSelect id={`${id}-lang`} label="Language" value={query.lang ?? ""} onChange={(v) => set("lang", v as PatientListQuery["lang"])} options={LANGUAGE_OPTIONS} any="Any language" />
        <FilterSelect id={`${id}-source`} label="Source" value={query.source ?? ""} onChange={(v) => set("source", v as PatientListQuery["source"])} options={SOURCE_OPTIONS} any="Any source" />
        <FilterSelect
          id={`${id}-archived`}
          label="Archived"
          value={query.archived ?? ""}
          onChange={(v) => set("archived", v as PatientListQuery["archived"])}
          options={ARCHIVED_OPTIONS.filter((o) => o.key !== "")}
          any="Active only"
        />
      </div>

      {/* Active filters */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          {total} {total === 1 ? "match" : "matches"}
        </span>
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => navigate(withoutFilter(query, chip.key as PatientFilterKey))}
            aria-label={`Clear filter ${chip.label}`}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-accent-muted px-2 text-[11px] font-medium text-accent hover:bg-accent/20"
          >
            <span className="truncate">{chip.label}</span>
            <X className="h-3 w-3 shrink-0" />
          </button>
        ))}
        {filtered ? (
          <button
            type="button"
            onClick={() => navigate({ sort: query.sort })}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        ) : (
          <span>No filters — showing every active patient.</span>
        )}
      </div>
    </div>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const id = useId();
  const [text, setText] = useState(initial);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSearch(text.trim());
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end" role="search">
      <div className="sm:w-80">
        <Field label="Search" htmlFor={id} hint="Name, phone, national ID or e-mail">
          <Input
            id={id}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Sara, 0101 234 5678, 2900101…"
            maxLength={100}
            autoComplete="off"
          />
        </Field>
      </div>
      <Button type="submit" variant="outline" size="lg" className="sm:mb-[1.4rem]">
        <Search className="h-4 w-4" />
        Search
      </Button>
    </form>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  any,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { key: string; label: string }[];
  any: string;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
