"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, OctagonAlert, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Alert } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { normaliseClinicalTerm } from "@/modules/consultations/normalise";
import { ruleLabel } from "@/modules/consultations/safety/labels";
import {
  SAFETY_REASON_MAX_LENGTH,
  SAFETY_REASON_MIN_LENGTH,
  type ClinicalExtraction,
  type SafetyCheckContext,
  type SafetyCheckResponse,
  type SafetyFinding,
  type SafetyOverrideInput,
} from "@/modules/consultations/types";

/** Overrides answer findings by rule and medication (the server matches the same way). */
export function findingKey(f: { rule: string; medication: string }): string {
  return `${f.rule}|${normaliseClinicalTerm(f.medication)}`;
}

/** Changes whenever the set of warnings changes, so an acknowledgement never carries over to new ones. */
export function warningSignature(findings: readonly SafetyFinding[]): string {
  return findings
    .filter((f) => f.severity === "warn")
    .map((f) => `${findingKey(f)}|${f.message}`)
    .sort()
    .join("\n");
}

export interface SafetyCheckRequest {
  medications: ClinicalExtraction["medications"];
  diagnoses: string[];
  stopMedicationIds: string[];
}

export interface SafetyCheckState {
  findings: SafetyFinding[];
  context: SafetyCheckContext | null;
  /** A request is waiting for the debounce or the server. */
  pending: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 450;

/**
 * Live prescribing checks while the clinician edits: the review panel's
 * medications, diagnoses and stops go to the safety-check endpoint, debounced.
 * `pending` stays true from the edit until the matching answer arrives, so
 * the Sign button never relies on findings for an older list.
 */
export function useSafetyCheck(consultationId: string, request: SafetyCheckRequest): SafetyCheckState {
  const body = useMemo(() => JSON.stringify(request), [request]);
  const [answer, setAnswer] = useState<{ body: string; findings: SafetyFinding[]; context: SafetyCheckContext | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      apiFetch<SafetyCheckResponse>(`/api/consultations/${consultationId}/safety-check`, { method: "POST", body: JSON.parse(body) as unknown })
        .then((data) => {
          if (!cancelled) setAnswer({ body, findings: data.findings, context: data.context, error: null });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setAnswer((prev) => ({
            body,
            findings: prev?.findings ?? [],
            context: prev?.context ?? null,
            error: err instanceof Error ? err.message : "The safety checks could not run.",
          }));
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [consultationId, body]);

  return {
    findings: answer?.findings ?? [],
    context: answer?.context ?? null,
    pending: answer?.body !== body,
    error: answer?.body === body ? answer.error : null,
  };
}

/** The overrides to send with the signature: one per stop, with its typed reason. */
export function overridesFor(findings: readonly SafetyFinding[], reasons: Readonly<Record<string, string>>): SafetyOverrideInput[] {
  const out = new Map<string, SafetyOverrideInput>();
  for (const f of findings) {
    if (f.severity !== "stop") continue;
    const key = findingKey(f);
    const reason = (reasons[key] ?? "").trim();
    if (reason.length >= SAFETY_REASON_MIN_LENGTH && !out.has(key)) out.set(key, { rule: f.rule, medication: f.medication, reason });
  }
  return [...out.values()];
}

/** True when every stop has a long-enough reason. */
export function stopsResolved(findings: readonly SafetyFinding[], reasons: Readonly<Record<string, string>>): boolean {
  return findings.every((f) => f.severity !== "stop" || (reasons[findingKey(f)] ?? "").trim().length >= SAFETY_REASON_MIN_LENGTH);
}

interface StopGroup {
  key: string;
  medication: string;
  findings: SafetyFinding[];
}

function groupStops(findings: readonly SafetyFinding[]): StopGroup[] {
  const groups = new Map<string, StopGroup>();
  for (const f of findings) {
    if (f.severity !== "stop") continue;
    const key = findingKey(f);
    const group = groups.get(key) ?? { key, medication: f.medication, findings: [] };
    group.findings.push(f);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function reasonPlaceholder(rule: string): string {
  if (rule.startsWith("pregnancy")) return "e.g. Pregnancy test negative today; two contraceptives";
  if (rule.startsWith("allergy")) return "e.g. Childhood rash only; tolerated it in 2024";
  if (rule.startsWith("interaction")) return "e.g. Benefit outweighs risk; monitoring arranged";
  return "e.g. Needed despite this because…";
}

/**
 * "Safety checks" above the Sign button: stops in red, each with a reason box
 * ("Why are you prescribing this anyway?"), warnings in amber with one
 * acknowledgement, and what the checks were run against.
 */
export function SafetyPanel({
  findings,
  context,
  pending,
  error,
  hasMedications,
  reasons,
  onReasonChange,
  acknowledged,
  onAcknowledgedChange,
  serverNotice,
  disabled = false,
}: {
  findings: SafetyFinding[];
  context: SafetyCheckContext | null;
  pending: boolean;
  error: string | null;
  hasMedications: boolean;
  reasons: Readonly<Record<string, string>>;
  onReasonChange: (key: string, reason: string) => void;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  /** The server refused the signature for these findings. */
  serverNotice?: string | null;
  disabled?: boolean;
}) {
  const stops = groupStops(findings);
  const warnings = findings.filter((f) => f.severity === "warn");
  const stopCount = findings.filter((f) => f.severity === "stop").length;

  return (
    <section aria-labelledby="safety-checks-title" className="space-y-3 rounded-lg border border-border p-3 sm:p-4" data-testid="safety-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="safety-checks-title" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-accent" aria-hidden="true" />
          Safety checks
        </h3>
        <span className="flex items-center gap-2">
          {pending ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Checking…
            </span>
          ) : null}
          {stopCount ? <Badge tone="danger">{stopCount} {stopCount === 1 ? "stop" : "stops"}</Badge> : null}
          {warnings.length ? (
            <Badge tone="warning">
              {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
            </Badge>
          ) : null}
          {!pending && hasMedications && !findings.length && !error ? <Badge tone="success">no problems found</Badge> : null}
        </span>
      </div>

      {serverNotice ? <Alert>{serverNotice}</Alert> : null}
      {error ? (
        <Alert tone="info">
          The safety checks could not run here ({error}). They run again on the server when you sign.
        </Alert>
      ) : null}

      {!hasMedications ? (
        <p className="text-xs text-muted-foreground">No medications to check.</p>
      ) : null}

      {stops.map((group) => {
        const reason = reasons[group.key] ?? "";
        const short = reason.trim().length < SAFETY_REASON_MIN_LENGTH;
        const id = `safety-reason-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
        return (
          <div key={group.key} className="space-y-2 rounded-lg border border-danger/30 bg-danger/5 p-3" data-testid="safety-stop">
            {group.findings.map((f, i) => (
              <p key={`${f.rule}-${i}`} className="flex gap-2 text-sm">
                <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-medium text-danger">Stop · {ruleLabel(f.rule)}</span>
                  <span className="block break-words">{f.message}</span>
                </span>
              </p>
            ))}
            <label htmlFor={id} className="data-label block pt-1">
              Why are you prescribing {group.medication} anyway?
            </label>
            <DictationField onDictated={(value) => onReasonChange(group.key, value.slice(0, SAFETY_REASON_MAX_LENGTH))} disabled={disabled}>
              <Textarea
                id={id}
                rows={2}
                maxLength={SAFETY_REASON_MAX_LENGTH}
                value={reason}
                disabled={disabled}
                aria-invalid={short}
                onChange={(e) => onReasonChange(group.key, e.target.value)}
                placeholder={reasonPlaceholder(group.findings[0]!.rule)}
                className="min-h-[4rem] bg-card"
              />
            </DictationField>
            <p className={cn("text-xs", short ? "text-danger" : "text-muted-foreground")}>
              {short
                ? `A reason of at least ${SAFETY_REASON_MIN_LENGTH} characters is needed to sign.`
                : "Recorded with your signature and reviewed by the clinic owner."}
            </p>
          </div>
        );
      })}

      {warnings.length ? (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3" data-testid="safety-warnings">
          <ul className="space-y-2">
            {warnings.map((f, i) => (
              <li key={`${findingKey(f)}-${i}`} className="flex gap-2 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="font-medium text-warning">{ruleLabel(f.rule)}</span>
                  <span className="block break-words">{f.message}</span>
                </span>
              </li>
            ))}
          </ul>
          <label className="flex cursor-pointer items-start gap-2 border-t border-warning/30 pt-2 text-sm font-medium">
            <Checkbox
              checked={acknowledged}
              disabled={disabled}
              onChange={(e) => onAcknowledgedChange(e.target.checked)}
              className="mt-0.5"
              data-testid="safety-acknowledge"
            />
            I have reviewed these warnings
          </label>
        </div>
      ) : null}

      {!pending && hasMedications && !findings.length && !error ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          No allergy, interaction, duplicate, pregnancy, age, dose or condition problems found.
        </p>
      ) : null}

      {context ? <CheckedAgainst context={context} /> : null}
    </section>
  );
}

function CheckedAgainst({ context }: { context: SafetyCheckContext }) {
  const sex = context.sex === "FEMALE" ? "female" : context.sex === "MALE" ? "male" : "sex not recorded";
  const age = context.age === null ? "age not recorded" : `${context.age} years`;
  return (
    <div className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Checked against:</span> {sex}, {age} ·{" "}
        {context.allergies.length ? `allergies: ${context.allergies.join(", ")}` : "no allergies recorded"} ·{" "}
        {context.activeMedications.length ? `current: ${context.activeMedications.join(", ")}` : "no current medications"}
        {context.conditions.length ? ` · conditions: ${context.conditions.join(", ")}` : ""}
      </p>
      {!context.allergies.length ? (
        <p className="text-warning">No allergies are recorded for this patient: confirm with the patient before prescribing.</p>
      ) : null}
      <p>Starter drug list: medicines it does not know are not checked.</p>
    </div>
  );
}
