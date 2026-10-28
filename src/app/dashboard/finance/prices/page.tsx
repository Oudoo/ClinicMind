import type { Metadata } from "next";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db, notDeleted } from "@/lib/db";
import { formatDateInTz, fromDateKey } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { CATEGORY_LABELS, PRICE_CATEGORIES, unitPhrase } from "@/modules/finance/constants";
import { listPriceList } from "@/modules/finance/prices";
import { listTreatments } from "@/modules/treatments/service";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { EditPriceItemButton, NewPriceItemButton, type PriceFormOptions } from "@/components/clinicmind/price-list-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Price list" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/prices` — the clinic's price list: every billable item
 * with its code, unit and price on a day (today unless another is chosen), a
 * branch's own price when it has one, and the next scheduled change. Every
 * member of staff can look prices up; the owner (`prices:manage`) adds items
 * and schedules changes.
 */
export default async function PriceListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  const canManage = can(ctx.role, "prices:manage");
  const query = {
    q: first(sp.q) ?? "",
    category: first(sp.category) ?? "",
    at: first(sp.at) ?? "",
    clinicId: first(sp.clinicId) ?? "",
    includeInactive: first(sp.includeInactive) === "1",
  };
  const [list, clinics, treatments] = await Promise.all([
    listPriceList(ctx.tenantId, query).catch(() => listPriceList(ctx.tenantId, { includeInactive: query.includeInactive })),
    db.clinic.findMany({ where: { tenantId: ctx.tenantId, ...notDeleted }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    canManage ? listTreatments(ctx.tenantId) : Promise.resolve([]),
  ]);
  const { items, timezone } = list;
  const branchName = new Map(clinics.map((c) => [c.id, c.name]));
  const day = (key: string) => formatDateInTz(fromDateKey(key, timezone) ?? new Date(), timezone, { day: "numeric", month: "short", year: "numeric" });
  const options: PriceFormOptions = {
    treatments: treatments.map((t) => ({ id: t.id, name: t.name, category: t.category })),
    clinics,
    sessionItems: items.filter((i) => i.unit !== "PACKAGE" && i.active).map((i) => ({ id: i.id, code: i.code, name: i.name })),
    timezone,
  };
  const filtered = Boolean(query.q || query.category || query.at || query.clinicId || query.includeInactive);
  const groups = PRICE_CATEGORIES.map((c) => ({ category: c, items: items.filter((i) => i.category === c) })).filter((g) => g.items.length);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Price list"
        description={`What each item costs${query.at ? ` on ${day(list.at)}` : " today"}. A change applies from the day it is set for; what was already charged keeps its price.`}
        action={canManage ? <NewPriceItemButton options={options} /> : undefined}
      />

      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Filter the price list">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={query.q} placeholder="Name or code" />
          </label>
          <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground sm:w-44">
            Category
            <Select name="category" defaultValue={query.category}>
              <option value="">All</option>
              {PRICE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground sm:w-40">
            Prices on
            <Input type="date" name="at" defaultValue={query.at} />
          </label>
          {clinics.length > 1 ? (
            <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground sm:w-44">
              Branch
              <Select name="clinicId" defaultValue={query.clinicId}>
                <option value="">Clinic-wide</option>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="includeInactive" value="1" defaultChecked={query.includeInactive} className="h-4 w-4 rounded border-input" />
            Retired items
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="outline">
              Apply
            </Button>
            {filtered ? (
              <a href="/dashboard/finance/prices" className="self-center text-sm text-muted-foreground underline-offset-2 hover:underline">
                Clear
              </a>
            ) : null}
          </div>
        </form>

        {groups.length ? (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH className="hidden w-32 sm:table-cell">Code</TH>
                <TH>Item</TH>
                <TH className="hidden md:table-cell">Treatment</TH>
                <TH className="text-right">Price</TH>
                <TH className="hidden lg:table-cell">Next change</TH>
                {canManage ? <TH className="w-12" aria-label="Edit" /> : null}
              </TR>
            </THead>
            {groups.map((g) => (
              <TBody key={g.category}>
                <TR className="bg-muted/40 hover:bg-muted/40">
                  <TD colSpan={canManage ? 6 : 5} className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {CATEGORY_LABELS[g.category]}
                  </TD>
                </TR>
                {g.items.map((i) => (
                  <TR key={i.id} className="align-top">
                    <TD className="hidden font-mono text-xs sm:table-cell">{i.code}</TD>
                    <TD>
                      {/* On a phone the code rides above the name, leaving the width to the price. */}
                      <div className="font-mono text-[11px] text-muted-foreground sm:hidden">{i.code}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{i.name}</span>
                        {i.active ? null : <Badge tone="warning">Retired</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {unitPhrase(i.unit, i.unitLabel, i.sessions)}
                        {i.sessionItem ? ` of ${i.sessionItem.code}` : ""}
                        {i.saving && i.saving > 0 ? ` · saves ${formatNumber(i.saving)} EGP` : ""}
                      </div>
                      {i.next ? (
                        <div className="text-xs text-muted-foreground lg:hidden">
                          From {day(i.next.effectiveFrom)}: {formatNumber(i.next.amount)} EGP
                        </div>
                      ) : null}
                    </TD>
                    <TD className="hidden text-sm text-muted-foreground md:table-cell">{i.treatment.name}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {i.price === null ? (
                        <span className="text-xs text-muted-foreground">No price yet</span>
                      ) : (
                        <>
                          <div className="font-mono tabular-nums">{formatNumber(i.price)} EGP</div>
                          <div className="text-xs text-muted-foreground">
                            {i.branchPrice && query.clinicId ? `${branchName.get(query.clinicId) ?? "Branch"} · ` : ""}since {i.priceSince ? day(i.priceSince) : "—"}
                          </div>
                          {!query.clinicId && i.branchPrices.length ? (
                            <div className="text-xs text-muted-foreground">
                              {i.branchPrices.map((b) => `${branchName.get(b.clinicId) ?? "Branch"}: ${formatNumber(b.amount)}`).join(" · ")}
                            </div>
                          ) : null}
                        </>
                      )}
                    </TD>
                    <TD className="hidden whitespace-nowrap text-sm lg:table-cell">
                      {i.next ? (
                        <>
                          <span className="font-mono tabular-nums">{formatNumber(i.next.amount)} EGP</span>
                          <div className="text-xs text-muted-foreground">
                            from {day(i.next.effectiveFrom)}
                            {i.next.clinicId ? ` · ${branchName.get(i.next.clinicId) ?? "branch"}` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TD>
                    {canManage ? (
                      <TD className="pl-0 pr-3 text-right sm:px-5">
                        <EditPriceItemButton itemId={i.id} label={`Edit ${i.name}`} options={options} />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            ))}
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState
              title={filtered ? "Nothing on the price list matches" : "The price list is empty"}
              hint={filtered ? "Clear the filters to see every item." : canManage ? "Add the first item: its code, unit and price." : "The clinic owner adds the items and their prices."}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
