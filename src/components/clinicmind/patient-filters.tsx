"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Download, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/primitives";
import { formatNumber } from "@/lib/utils";
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
  parsePatientListQuery,
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

/** The controls of the list sit on the page, a step shorter than a form field. */
const CONTROL = "h-9 bg-card";

/**
 * The controls of the patient list: the search first, then the view, the sort order, the
 * filters (folded away until asked for) and the export. Every control writes the URL
 * (router.replace) at once and the server page re-renders the list; nothing is filtered
 * client-side. The filters in force stay in view as chips with an X.
 */
export function PatientFilters({
  query,
  total,
  doctors,
  tags,
  views,
  canSaveViews,
  canExport = false,
}: {
  query: PatientListQuery;
  total: number;
  doctors: DoctorOption[];
  tags: { tag: string; count: number }[];
  views: SavedViewDTO[];
  canSaveViews: boolean;
  /** Bulk export is an owner action (patients:export). */
  canExport?: boolean;
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
  // The search has its own box; the count on the button is of the filters behind it.
  const inPanel = chips.filter((c) => c.key !== "q").length;
  const exportHref = `/api/patients/export?${patientQueryParams({ ...query, page: undefined }).toString()}`;
  const tagOptions = query.tag && !tags.some((t) => t.tag === query.tag) ? [{ tag: query.tag, count: 0 }, ...tags] : tags;

  // The view in force: a quick view, one of the user's saved views, every patient, or none of them.
  const saved = views.map((view) => ({ view, query: parsePatientListQuery(view.params) }));
  const quick = QUICK_VIEWS.find((v) => matchesQuickView(query, v.query));
  const mine = saved.find((s) => matchesQuickView(query, s.query) && (query.sort ?? DEFAULT_SORT) === (s.query.sort ?? DEFAULT_SORT));
  const current = mine ? `saved:${mine.view.id}` : quick ? `quick:${quick.key}` : filtered ? "custom" : "";

  function chooseView(value: string) {
    if (value.startsWith("quick:")) {
      const view = QUICK_VIEWS.find((v) => `quick:${v.key}` === value);
      if (view) navigate({ ...view.query, sort: query.sort });
    } else if (value.startsWith("saved:")) {
      const view = saved.find((s) => `saved:${s.view.id}` === value);
      if (view) navigate(view.query);
    } else if (value === "") {
      navigate({ sort: query.sort });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <SearchBox key={query.q ?? ""} initial={query.q ?? ""} onSearch={(q) => set("q", q)} />
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <div className="col-span-2 flex min-w-0 gap-2 sm:col-span-1">
            <Select aria-label="View" value={current} onChange={(e) => chooseView(e.target.value)} className={`${CONTROL} min-w-0 sm:w-48`}>
              <option value="">All patients</option>
              {current === "custom" ? (
                <option value="custom" disabled>
                  Filtered list
                </option>
              ) : null}
              {QUICK_VIEWS.map((view) => (
                <option key={view.key} value={`quick:${view.key}`}>
                  {view.label}
                </option>
              ))}
              {saved.length ? (
                <optgroup label="Saved views">
                  {saved.map(({ view }) => (
                    <option key={view.id} value={`saved:${view.id}`}>
                      {view.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
            {canSaveViews ? <PatientSavedViews query={query} views={views} /> : null}
          </div>
          <Select
            aria-label="Sort"
            value={query.sort ?? DEFAULT_SORT}
            onChange={(e) => navigate({ ...query, page: undefined, sort: e.target.value as PatientListQuery["sort"] })}
            className={`${CONTROL} col-span-2 sm:w-48`}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button type="button" variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${id}-panel`}>
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {inPanel ? <span className="tabular-nums text-muted-foreground">{inPanel}</span> : null}
          </Button>
          {canExport ? (
            <Button asChild variant="outline">
              <a href={exportHref} download title="Export the list as shown to a CSV file (UTF-8, opens in Excel)">
                <Download className="h-4 w-4" />
                Export CSV
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Every filter, folded away until asked for: each one applies as soon as it is chosen. */}
      {open ? (
        <Card id={`${id}-panel`} className="grid grid-cols-2 gap-3 p-4 md:grid-cols-3 lg:grid-cols-5">
          <FilterSelect id={`${id}-gender`} label="Gender" value={query.gender ?? ""} onChange={(v) => set("gender", v as PatientListQuery["gender"])} options={GENDER_OPTIONS} any="Any gender" />
          <FilterSelect id={`${id}-age`} label="Age" value={query.age ?? ""} onChange={(v) => set("age", v as PatientListQuery["age"])} options={AGE_BANDS} any="Any age" />
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
                <Input id={`${id}-from`} type="date" value={query.from ?? ""} onChange={(e) => set("from", e.target.value)} className="h-9" />
              </Field>
              <Field label="To" htmlFor={`${id}-to`}>
                <Input id={`${id}-to`} type="date" value={query.to ?? ""} onChange={(e) => set("to", e.target.value)} className="h-9" />
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
        </Card>
      ) : null}

      {/* What the list is narrowed to, each one a button that lifts it. */}
      {filtered ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {formatNumber(total)} {total === 1 ? "patient" : "patients"}
          </span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => navigate(withoutFilter(query, chip.key as PatientFilterKey))}
              aria-label={`Clear filter ${chip.label}`}
              className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-accent-muted px-2 text-xs font-medium text-accent hover:bg-accent/20"
            >
              <span className="truncate">{chip.label}</span>
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </button>
          ))}
          <button type="button" onClick={() => navigate({ sort: query.sort })} className="rounded-sm text-xs font-medium underline-offset-2 hover:text-foreground hover:underline">
            Clear all
          </button>
        </div>
      ) : null}
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
    <form onSubmit={submit} className="flex min-w-0 flex-1 gap-2" role="search">
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          id={id}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, phone, national ID or e-mail"
          maxLength={100}
          autoComplete="off"
          className={`${CONTROL} ps-9`}
        />
      </div>
      <Button type="submit" variant="outline">
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
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9">
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
