"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** API key creation that shows the raw key exactly once. */
export function ApiKeyForm({
  createApiKey,
}: {
  createApiKey: (formData: FormData) => Promise<{ ok?: boolean; apiKey?: string; error?: string }>;
}) {
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await createApiKey(form);
      if (result.error) setError(result.error);
      else setRawKey(result.apiKey ?? null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create API key</CardTitle>
        <CardDescription>The key is shown once — store it securely.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Key name</Label>
            <Input name="name" placeholder="Reporting pipeline" required />
          </div>
          <Button type="submit" disabled={pending}>Create</Button>
        </form>
        {rawKey && (
          <div className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3">
            <div className="text-xs font-semibold text-emerald-800">Your new API key (copy now):</div>
            <code className="mt-1 block break-all text-sm">{rawKey}</code>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function RetentionRow({
  policy,
  updateRetentionPolicy,
}: {
  policy: { id: string; dataCategory: string; retentionDays: number; lastEnforcedAt: string | null };
  updateRetentionPolicy: (policyId: string, retentionDays: number) => Promise<{ ok?: boolean; error?: string }>;
}) {
  const [days, setDays] = useState(policy.retentionDays);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <div>
        <div className="text-sm font-medium capitalize">{policy.dataCategory.replace(/_/g, " ")}</div>
        <div className="text-xs text-muted-foreground">
          last enforced: {policy.lastEnforcedAt ? policy.lastEnforcedAt.slice(0, 10) : "never"}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={days}
          min={7}
          max={3650}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-24"
        />
        <span className="text-xs text-muted-foreground">days</span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await updateRetentionPolicy(policy.id, days);
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            })
          }
        >
          {saved ? "Saved ✓" : "Save"}
        </Button>
      </div>
    </div>
  );
}
