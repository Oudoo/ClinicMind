"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Pencil, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatDateTimeInTz } from "@/lib/time";
import { ALERT_METRIC_IS_SNAPSHOT, ALERT_METRIC_LABELS, ALERT_METRICS, type AlertMetricValue } from "@/modules/reporting/definitions";
import { MetricBadge } from "./report-shared";

export interface AlertRuleDTO {
  id: string;
  name: string;
  metric: AlertMetricValue;
  comparator: "ABOVE" | "BELOW";
  threshold: number;
  windowDays: number;
  notifyRoles: string[];
  enabled: boolean;
  lastValue: number | null;
  lastEvaluatedAt: string | null;
  lastFiredAt: string | null;
}

const ROLE_LABELS: Record<string, string> = { CLINIC_OWNER: "Owner", DOCTOR: "Doctors", NURSE: "Nurses", RECEPTIONIST: "Reception", ASSISTANT: "Assistants" };
const ROLES = Object.keys(ROLE_LABELS);

const shown = (metric: AlertMetricValue, v: number | null) => {
  if (v === null || v === undefined) return "—";
  const unit = ALERT_METRIC_LABELS[metric]?.unit ?? "";
  const n = Number.isInteger(v) ? v.toLocaleString("en-US") : (Math.round(v * 10) / 10).toLocaleString("en-US");
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
};

const condition = (r: Pick<AlertRuleDTO, "metric" | "comparator" | "threshold" | "windowDays">) =>
  `${r.comparator === "ABOVE" ? "above" : "below"} ${shown(r.metric, r.threshold)}${ALERT_METRIC_IS_SNAPSHOT[r.metric] ? ", as of now" : ` over ${r.windowDays} ${r.windowDays === 1 ? "day" : "days"}`}`;

/**
 * Alert rules: a threshold on a reported metric over a window of days. The
 * hourly job evaluates every enabled rule and notifies the roles it names, at
 * most once a day per rule; "Evaluate now" runs them on demand. The owner
 * adds, edits and disables rules.
 */
export function ReportAlertRules({ rules, canEdit, timezone }: { rules: AlertRuleDTO[]; canEdit: boolean; timezone: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<AlertRuleDTO | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function evaluate() {
    setBusy("evaluate");
    try {
      const res = await apiFetch<{ results: { fired: boolean; notified: boolean }[] }>("/api/alert-rules/evaluate", { method: "POST" });
      const fired = res.results.filter((r) => r.fired).length;
      const notified = res.results.filter((r) => r.notified).length;
      toast({
        tone: fired ? "info" : "success",
        title: `${res.results.length} ${res.results.length === 1 ? "rule" : "rules"} evaluated`,
        description: fired ? `${fired} over the line; ${notified} notified now (a rule notifies at most once a day).` : "Nothing over the line.",
      });
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Could not evaluate", description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(rule: AlertRuleDTO) {
    setBusy(rule.id);
    try {
      await apiFetch(`/api/alert-rules/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } });
      toast({ tone: "success", title: rule.enabled ? "Rule disabled" : "Rule enabled", description: rule.name });
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Could not change the rule", description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add rule
          </Button>
          <Button size="sm" variant="outline" onClick={() => void evaluate()} disabled={busy !== null || !rules.some((r) => r.enabled)}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {busy === "evaluate" ? "Evaluating…" : "Evaluate now"}
          </Button>
        </div>
      ) : null}
      {rules.length ? (
        <ul className="space-y-2">
          {rules.map((r) => {
            const meta = ALERT_METRIC_LABELS[r.metric];
            const over = r.lastValue !== null && (r.comparator === "ABOVE" ? r.lastValue > r.threshold : r.lastValue < r.threshold);
            return (
              <li key={r.id} className={r.enabled ? "rounded-lg border border-border p-3" : "rounded-lg border border-dashed border-border p-3 opacity-70"}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {meta?.metric ? <MetricBadge id={meta.metric} /> : null}
                      <span className="font-medium">{r.name}</span>
                      {!r.enabled ? <Badge>disabled</Badge> : over ? <Badge tone="warning">over the line</Badge> : r.lastEvaluatedAt ? <Badge tone="success">ok</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {meta?.label ?? r.metric} {condition(r)} · tells {r.notifyRoles.map((role) => ROLE_LABELS[role] ?? role).join(", ")}
                    </p>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => void toggle(r)} disabled={busy !== null}>
                        {r.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="data-label inline">Last value </dt>
                    <dd className="inline font-mono tabular-nums">{shown(r.metric, r.lastValue)}</dd>
                  </div>
                  <div>
                    <dt className="data-label inline">Evaluated </dt>
                    <dd className="inline font-mono">{r.lastEvaluatedAt ? formatDateTimeInTz(new Date(r.lastEvaluatedAt), timezone) : "not yet"}</dd>
                  </div>
                  <div>
                    <dt className="data-label inline">Last fired </dt>
                    <dd className="inline font-mono">
                      {r.lastFiredAt ? (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <BellRing className="h-3 w-3" aria-hidden="true" />
                          {formatDateTimeInTz(new Date(r.lastFiredAt), timezone)}
                        </span>
                      ) : (
                        "never"
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No alert rules" hint={canEdit ? "Add one: for example, the no-show rate above 10% over 14 days." : "The clinic owner sets alert rules."} />
      )}
      {editing ? <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function RuleDialog({ rule, onClose }: { rule: AlertRuleDTO | null; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(rule?.name ?? "");
  const [metric, setMetric] = useState<AlertMetricValue>(rule?.metric ?? "NO_SHOW_RATE");
  const [comparator, setComparator] = useState<"ABOVE" | "BELOW">(rule?.comparator ?? "ABOVE");
  const [threshold, setThreshold] = useState(rule ? String(rule.threshold) : "10");
  const [windowDays, setWindowDays] = useState(rule ? String(rule.windowDays) : "14");
  const [roles, setRoles] = useState<string[]>(rule?.notifyRoles ?? ["CLINIC_OWNER"]);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meta = ALERT_METRIC_LABELS[metric];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = Number(threshold.replace(/[,\s]/g, ""));
    const w = Number(windowDays);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Name the rule.";
    if (!Number.isFinite(t)) next.threshold = "A number.";
    if (!Number.isInteger(w) || w < 1 || w > 365) next.windowDays = "1 to 365 days.";
    if (!roles.length) next.notifyRoles = "Choose who is told.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), metric, comparator, threshold: t, windowDays: w, notifyRoles: roles, enabled };
    try {
      if (rule) await apiFetch(`/api/alert-rules/${rule.id}`, { method: "PATCH", body });
      else await apiFetch("/api/alert-rules", { method: "POST", body });
      toast({ tone: "success", title: rule ? "Rule saved" : "Rule added", description: body.name });
      onClose();
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const issue = (k: string) => (issues[k] ? <span className="text-danger">{issues[k]}</span> : undefined);
  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent title={rule ? "Edit alert rule" : "Add an alert rule"} description="Evaluated every hour; a rule notifies at most once a day.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`} hint={issue("name")}>
            <DictationField multiline={false} onDictated={setName} disabled={busy}>
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. No-show rate above 10%" />
            </DictationField>
          </Field>
          <Field label="Metric" htmlFor={`${id}-metric`} hint={issue("metric")}>
            <Select id={`${id}-metric`} value={metric} onChange={(e) => setMetric(e.target.value as AlertMetricValue)}>
              {ALERT_METRICS.map((m) => (
                <option key={m} value={m}>
                  {ALERT_METRIC_LABELS[m].metric ? `${ALERT_METRIC_LABELS[m].metric} · ` : ""}
                  {ALERT_METRIC_LABELS[m].label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="When" htmlFor={`${id}-cmp`}>
              <Select id={`${id}-cmp`} value={comparator} onChange={(e) => setComparator(e.target.value as "ABOVE" | "BELOW")}>
                <option value="ABOVE">Above</option>
                <option value="BELOW">Below</option>
              </Select>
            </Field>
            <Field label={`Threshold${meta?.unit ? ` (${meta.unit})` : ""}`} htmlFor={`${id}-threshold`} hint={issue("threshold")}>
              <Input id={`${id}-threshold`} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </Field>
            <Field label="Days" htmlFor={`${id}-window`} hint={issue("windowDays") ?? (ALERT_METRIC_IS_SNAPSHOT[metric] ? "Not used: as of now" : undefined)}>
              <Input id={`${id}-window`} inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="data-label">Tell</legend>
            <div className="flex flex-wrap gap-3">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={roles.includes(role)} onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, role] : rs.filter((x) => x !== role)))} />
                  {ROLE_LABELS[role]}
                </label>
              ))}
            </div>
            {issue("notifyRoles")}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
