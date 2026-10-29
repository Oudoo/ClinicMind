"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { DISCOUNT_LIMITED_ROLES, type DiscountLimitedRole, type DiscountLimits } from "@/modules/finance/constants";

const ROLE_LABELS: Record<DiscountLimitedRole, string> = { RECEPTIONIST: "Reception", NURSE: "Nurses", DOCTOR: "Doctors" };

/**
 * How much each role may take off a price without the owner, as a
 * percentage: the owner changes it, everyone else reads it. The server holds
 * every discount to it.
 */
export function DiscountLimitsCard({ initial, canEdit }: { initial: DiscountLimits; canEdit: boolean }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<Record<DiscountLimitedRole, string>>(Object.fromEntries(DISCOUNT_LIMITED_ROLES.map((r) => [r, String(initial[r])])) as Record<DiscountLimitedRole, string>);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    const limits = {} as DiscountLimits;
    for (const r of DISCOUNT_LIMITED_ROLES) {
      const n = Number(values[r]);
      if (!Number.isInteger(n) || n < 0 || n > 100) next[r] = "0 to 100";
      else limits[r] = n;
    }
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/finance/settings", { method: "PUT", body: { discountLimits: limits } });
      toast({ tone: "success", title: "Discount limits saved" });
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : "Could not save the limits.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <SectionTitle title="Discounts" description="How much each role may take off a price, as a share of it. More needs the owner, who has no limit; every discount needs its reason." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <div className="grid grid-cols-3 gap-3">
          {DISCOUNT_LIMITED_ROLES.map((r) => (
            <Field key={r} label={`${ROLE_LABELS[r]} (%)`} htmlFor={`${id}-${r}`} hint={issues[r] ? <span className="text-danger">{issues[r]}</span> : undefined}>
              <Input
                id={`${id}-${r}`}
                inputMode="numeric"
                value={values[r]}
                onChange={(e) => setValues((v) => ({ ...v, [r]: e.target.value }))}
                disabled={!canEdit}
                aria-invalid={issues[r] ? true : undefined}
              />
            </Field>
          ))}
        </div>
        {canEdit ? (
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Save limits"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Set by the clinic owner.</p>
        )}
      </form>
    </Card>
  );
}
