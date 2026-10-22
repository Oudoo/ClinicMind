import Link from "next/link";
import { Search, X } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { historyLists, listPatients } from "@/modules/patients/service";
import { ageFrom, initials } from "@/lib/utils";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ToastProvider } from "@/components/ui/toast";
import { AddPatientButton } from "@/components/clinicmind/patient-form-dialog";
import { GENDER_LABELS } from "@/components/clinicmind/patient-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
type ListQuery = { q?: string; tag?: string; archived?: string; page?: string };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function listHref(query: ListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `/dashboard/patients?${qs}` : "/dashboard/patients";
}

export default async function PatientsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const q = first(sp.q)?.trim() || undefined;
  const tag = first(sp.tag)?.trim() || undefined;
  const includeArchived = first(sp.archived) === "1";
  const page = Number.parseInt(first(sp.page) ?? "1", 10) || 1;

  const result = await listPatients(ctx.tenantId, { q, tag, page, includeArchived });
  const { patients, total, pageSize } = result;
  const canWrite = can(ctx.role, "patients:write");
  const filtered = Boolean(q || tag);
  const query: ListQuery = { q, tag, archived: includeArchived ? "1" : undefined };

  return (
    <ToastProvider>
      <div className="space-y-6">
        <SectionTitle
          title="Patients"
          description="Unified patient registry with clinical context."
          action={
            <div className="flex items-center gap-2">
              <Badge tone="accent">
                {total} {total === 1 ? "record" : "records"}
              </Badge>
              {canWrite ? <AddPatientButton /> : null}
            </div>
          }
        />

        <Card className="overflow-hidden p-0">
          <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-end md:justify-between">
            <form
              method="get"
              action="/dashboard/patients"
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
            >
              <div className="sm:w-80">
                <Field label="Search" htmlFor="patients-q">
                  <Input
                    id="patients-q"
                    name="q"
                    type="search"
                    defaultValue={q ?? ""}
                    placeholder="Name, phone or e-mail"
                    maxLength={100}
                  />
                </Field>
              </div>
              {tag ? <input type="hidden" name="tag" value={tag} /> : null}
              {includeArchived ? <input type="hidden" name="archived" value="1" /> : null}
              <Button type="submit" variant="outline" size="lg">
                <Search className="h-4 w-4" />
                Search
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {tag ? (
                <Link
                  href={listHref({ ...query, tag: undefined })}
                  aria-label={`Clear the tag filter ${tag}`}
                  className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-accent hover:bg-accent/20"
                >
                  tag: {tag}
                  <X className="h-3 w-3" />
                </Link>
              ) : null}
              <Link
                href={listHref({ ...query, archived: includeArchived ? undefined : "1" })}
                className="underline-offset-2 hover:text-foreground hover:underline"
              >
                {includeArchived ? "Hide archived" : "Show archived"}
              </Link>
            </div>
          </div>

          {patients.length ? (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Patient</TH>
                  <TH>Age</TH>
                  <TH>Contact</TH>
                  <TH>Tags</TH>
                  <TH>Conditions</TH>
                  <TH className="text-right">Activity</TH>
                </TR>
              </THead>
              <TBody>
                {patients.map((p) => {
                  const conditions = historyLists(p.medicalHistory).chronicConditions;
                  const age = ageFrom(p.dateOfBirth);
                  return (
                    <TR key={p.id}>
                      <TD>
                        <div className="flex items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-muted font-mono text-xs text-accent"
                          >
                            {initials(p.fullName)}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                href={`/dashboard/patients/${p.id}`}
                                className="font-medium underline-offset-2 hover:text-accent hover:underline"
                              >
                                {p.fullName}
                              </Link>
                              {p.deletedAt ? <Badge tone="danger">archived</Badge> : null}
                            </div>
                            <p className="text-xs text-muted-foreground">{GENDER_LABELS[p.gender]}</p>
                          </div>
                        </div>
                      </TD>
                      <TD className="font-mono tabular-nums text-muted-foreground">{age ?? "—"}</TD>
                      <TD className="font-mono text-xs text-muted-foreground">
                        <div>{p.phone ?? "—"}</div>
                        {p.email ? <div className="max-w-[14rem] truncate">{p.email}</div> : null}
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {p.tags.map((t) => (
                            <Link key={t} href={listHref({ ...query, tag: t })} aria-label={`Filter by tag ${t}`}>
                              <Badge tone={t === tag ? "accent" : "default"}>{t}</Badge>
                            </Link>
                          ))}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {conditions.slice(0, 2).map((c) => (
                            <Badge key={c} tone="warning">
                              {c}
                            </Badge>
                          ))}
                          {conditions.length > 2 ? <Badge>+{conditions.length - 2}</Badge> : null}
                        </div>
                      </TD>
                      <TD className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                        {p._count.appointments} appts · {p._count.visits} visits
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState
                title={filtered ? "No patients match" : "No patients yet"}
                hint={
                  filtered
                    ? "Try another name, phone number or e-mail, or clear the filters."
                    : canWrite
                      ? "Add your first patient to start building their record."
                      : "Patients registered by the front desk or the AI receptionist appear here."
                }
              />
            </div>
          )}

          {total > 0 ? (
            <Pagination
              page={result.page}
              pageSize={pageSize}
              total={total}
              basePath="/dashboard/patients"
              query={query}
              className="border-t border-border"
            />
          ) : null}
        </Card>
      </div>
    </ToastProvider>
  );
}
