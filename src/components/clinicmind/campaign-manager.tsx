"use client";

import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FileUp, MoreHorizontal, Pencil, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { CAMPAIGN_PLATFORMS, LEAD_SOURCES, SOURCE_LABELS, type CampaignPlatformKey, type LeadSourceKey } from "@/modules/crm/shared";
import type { CampaignDTO, CostImportPreviewDTO } from "@/modules/crm/dto";
import { PLATFORM_LABELS, crmErrorMessage } from "./lead-shared";

export interface CampaignTreatmentOption {
  id: string;
  name: string;
}

const item = "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted";

export function NewCampaignButton({ treatments }: { treatments: CampaignTreatmentOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        New campaign
      </Button>
      {open ? <CampaignDialog treatments={treatments} onOpenChange={setOpen} /> : null}
    </>
  );
}

/** Edit, add a cost, import costs: one menu per campaign row. */
export function CampaignRowActions({ campaign, treatments }: { campaign: CampaignDTO; treatments: CampaignTreatmentOption[] }) {
  const [dialog, setDialog] = useState<null | "edit" | "cost" | "import">(null);
  const close = (open: boolean) => !open && setDialog(null);
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${campaign.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[12rem] rounded-lg border border-border bg-card p-1 shadow-lg animate-fade-in">
            <DropdownMenu.Item className={item} onSelect={() => setDialog("edit")}>
              <Pencil className="h-3.5 w-3.5" /> Edit campaign
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} onSelect={() => setDialog("cost")}>
              <Wallet className="h-3.5 w-3.5" /> Add a cost
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} onSelect={() => setDialog("import")}>
              <FileUp className="h-3.5 w-3.5" /> Import costs (CSV)
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dialog === "edit" ? <CampaignDialog campaign={campaign} treatments={treatments} onOpenChange={close} /> : null}
      {dialog === "cost" ? <CostDialog campaign={campaign} onOpenChange={close} /> : null}
      {dialog === "import" ? <ImportDialog campaign={campaign} onOpenChange={close} /> : null}
    </>
  );
}

const dayOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Create or edit a campaign as the ads platform names it. */
function CampaignDialog({ campaign, treatments, onOpenChange }: { campaign?: CampaignDTO; treatments: CampaignTreatmentOption[]; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [values, setValues] = useState({
    name: campaign?.name ?? "",
    externalId: campaign?.externalId ?? "",
    platform: (campaign?.platform ?? "META") as CampaignPlatformKey,
    source: (campaign?.source ?? "CLICK_TO_WHATSAPP_AD") as LeadSourceKey,
    treatmentId: campaign?.treatment?.id ?? "",
    active: campaign?.active ?? true,
    startedAt: dayOnly(campaign?.startedAt ?? null),
    endedAt: dayOnly(campaign?.endedAt ?? null),
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      if (campaign) await apiFetch(`/api/campaigns/${campaign.id}`, { method: "PATCH", body: values });
      else await apiFetch("/api/campaigns", { method: "POST", body: { ...values, startedAt: values.startedAt || undefined, endedAt: values.endedAt || undefined } });
      toast({ title: campaign ? "Campaign updated" : `Campaign added: ${values.name}`, tone: "success" });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={campaign ? `Edit ${campaign.name}` : "New campaign"} description="Use the platform's campaign id so leads from its ads attach themselves." className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`} hint={hint("name")}>
            <Input id={`${id}-name`} value={values.name} onChange={(e) => set("name", e.target.value)} maxLength={160} placeholder="Meta · Hair transplant click-to-WhatsApp" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Platform campaign id" htmlFor={`${id}-ext`} hint={hint("externalId", "From Ads Manager / Google Ads")}>
              <Input id={`${id}-ext`} value={values.externalId} onChange={(e) => set("externalId", e.target.value)} maxLength={120} className="font-mono" />
            </Field>
            <Field label="Platform" htmlFor={`${id}-platform`} hint={hint("platform")}>
              <Select id={`${id}-platform`} value={values.platform} onChange={(e) => set("platform", e.target.value as CampaignPlatformKey)}>
                {CAMPAIGN_PLATFORMS.map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Leads arrive as" htmlFor={`${id}-source`} hint={hint("source")}>
              <Select id={`${id}-source`} value={values.source} onChange={(e) => set("source", e.target.value as LeadSourceKey)}>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Treatment" htmlFor={`${id}-treatment`} hint={hint("treatmentId")}>
              <Select id={`${id}-treatment`} value={values.treatmentId} onChange={(e) => set("treatmentId", e.target.value)}>
                <option value="">Any (brand campaign)</option>
                {treatments.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Started" htmlFor={`${id}-start`} hint={hint("startedAt")}>
              <Input id={`${id}-start`} type="date" value={values.startedAt} onChange={(e) => set("startedAt", e.target.value)} />
            </Field>
            <Field label="Ended" htmlFor={`${id}-end`} hint={hint("endedAt", "Blank while it runs")}>
              <Input id={`${id}-end`} type="date" value={values.endedAt} min={values.startedAt || undefined} onChange={(e) => set("endedAt", e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={values.active} onChange={(e) => set("active", e.target.checked)} />
            Active (offered when a lead is added)
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : campaign ? "Save changes" : "Add campaign"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One period's spend, in whole EGP. */
function CostDialog({ campaign, onOpenChange }: { campaign: CampaignDTO; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [values, setValues] = useState({ periodStart: "", periodEnd: "", amount: "" });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await apiFetch(`/api/campaigns/${campaign.id}/costs`, { method: "POST", body: { ...values, amount: values.amount.replace(/[^\d]/g, "") } });
      toast({ title: `Cost added to ${campaign.name}`, description: `${formatNumber(Number(values.amount.replace(/[^\d]/g, "")))} EGP`, tone: "success" });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hint = (key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Add a cost" description={campaign.name}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor={`${id}-from`} hint={hint("periodStart")}>
              <Input id={`${id}-from`} type="date" value={values.periodStart} onChange={(e) => setValues((v) => ({ ...v, periodStart: e.target.value }))} />
            </Field>
            <Field label="To" htmlFor={`${id}-to`} hint={hint("periodEnd")}>
              <Input id={`${id}-to`} type="date" value={values.periodEnd} min={values.periodStart || undefined} onChange={(e) => setValues((v) => ({ ...v, periodEnd: e.target.value }))} />
            </Field>
            <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
              <Input id={`${id}-amount`} inputMode="numeric" value={values.amount} onChange={(e) => setValues((v) => ({ ...v, amount: e.target.value }))} placeholder="12000" className="font-mono" />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add cost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SAMPLE = "periodStart,periodEnd,amount\n2026-10-01,2026-10-07,3500\n2026-10-08,2026-10-14,4200";

/** Paste or upload `periodStart,periodEnd,amount` rows, preview them, then import. */
function ImportDialog({ campaign, onOpenChange }: { campaign: CampaignDTO; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CostImportPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 200_000) {
      setError("That file is larger than 200 KB.");
      return;
    }
    setCsv(await file.text());
    setPreview(null);
  }

  async function run(commit: boolean) {
    if (busy || !csv.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<CostImportPreviewDTO>(`/api/campaigns/${campaign.id}/costs/import`, { method: "POST", body: { csv, commit } });
      if (!commit) {
        setPreview(res);
        return;
      }
      const total = res.rows.reduce((s, r) => s + r.amount, 0);
      toast({ title: `${res.imported} costs imported`, description: `${formatNumber(total)} EGP on ${campaign.name}`, tone: "success" });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const csvErrors = (err as { body?: { issues?: { fieldErrors?: { csv?: string[] } } } }).body?.issues?.fieldErrors?.csv;
      setError(csvErrors?.length ? csvErrors.join(" · ") : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const total = preview ? preview.rows.reduce((s, r) => s + r.amount, 0) : 0;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Import costs" description={`${campaign.name} · one row per period: periodStart,periodEnd,amount (EGP).`} className="max-w-2xl">
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          <Field label="CSV" htmlFor={`${id}-csv`} hint={<>A header line is skipped. Example: <span className="font-mono">2026-10-01,2026-10-07,3500</span></>}>
            <Textarea
              id={`${id}-csv`}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setPreview(null);
              }}
              placeholder={SAMPLE}
              className="min-h-[8rem] font-mono text-xs"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">
              <FileUp className="h-4 w-4" />
              Choose a file
              <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void onFile(e)} className="sr-only" />
            </label>
            <Button type="button" variant="outline" size="sm" onClick={() => void run(false)} disabled={busy || !csv.trim()}>
              {busy && !preview ? "Reading…" : "Preview"}
            </Button>
          </div>
          {preview ? (
            <div className="space-y-2">
              <p className="text-sm">
                {preview.rows.length} {preview.rows.length === 1 ? "row" : "rows"} · {formatNumber(total)} EGP
                {preview.errors.length ? <span className="text-danger"> · {preview.errors.length} with problems (fix them before importing)</span> : null}
              </p>
              {preview.rows.length ? (
                <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
                  <Table>
                    <THead>
                      <TR className="hover:bg-transparent">
                        <TH>Line</TH>
                        <TH>From</TH>
                        <TH>To</TH>
                        <TH className="text-right">EGP</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {preview.rows.map((r) => (
                        <TR key={r.line}>
                          <TD className="font-mono text-xs text-muted-foreground">{r.line}</TD>
                          <TD className="font-mono text-xs">{r.periodStart}</TD>
                          <TD className="font-mono text-xs">{r.periodEnd}</TD>
                          <TD className="text-right font-mono text-xs tabular-nums">{formatNumber(r.amount)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : null}
              {preview.errors.length ? (
                <ul className="space-y-0.5 text-xs text-danger">
                  {preview.errors.map((e) => (
                    <li key={`${e.line}-${e.message}`}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={() => void run(true)} disabled={busy || !preview || !preview.rows.length || preview.errors.length > 0}>
              {busy && preview ? "Importing…" : preview?.rows.length ? `Import ${preview.rows.length} rows` : "Import"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
