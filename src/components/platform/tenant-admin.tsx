"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MailPlus, Pause, Play, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import type { TenantBranding } from "@/lib/brand";
import { CopyField } from "./new-tenant-dialog";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Suspend or re-activate a tenant. Suspension ends every session and refuses sign-in. */
export function TenantStatusActions({ tenantId, status, name }: { tenantId: string; status: string; name: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const suspended = status === "SUSPENDED";

  async function setStatus(next: "ACTIVE" | "SUSPENDED") {
    setBusy(true);
    try {
      await apiFetch(`/api/tenants/${tenantId}`, { method: "PATCH", body: { status: next } });
      toast({ title: next === "SUSPENDED" ? `${name} suspended` : `${name} is active`, tone: "success" });
      setConfirm(false);
      router.refresh();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Could not update the tenant.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return suspended ? (
    <Button type="button" variant="outline" disabled={busy} onClick={() => void setStatus("ACTIVE")}>
      <Play className="h-4 w-4" /> Activate
    </Button>
  ) : (
    <>
      <Button type="button" variant="outline" className="text-danger" disabled={busy} onClick={() => setConfirm(true)}>
        <Pause className="h-4 w-4" /> Suspend
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Suspend ${name}?`}
        description="Staff of this tenant can no longer sign in and embedded sessions stop working until it is activated again. Data is kept."
        confirmLabel="Suspend tenant"
        tone="danger"
        busy={busy}
        onConfirm={() => setStatus("SUSPENDED")}
      />
    </>
  );
}

/**
 * White-label editor. Used by the platform console (PATCH /api/tenants/[id],
 * wrapped in `branding`) and by the clinic owner's Settings (PATCH /api/tenant/branding).
 */
export function BrandingForm({
  initial,
  target,
  fallbackProductName = "ClinicMind",
}: {
  initial: TenantBranding;
  target: { kind: "platform"; tenantId: string } | { kind: "own" };
  fallbackProductName?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [productName, setProductName] = useState(initial.productName ?? "");
  const [accent, setAccent] = useState(initial.accent ?? "");
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setIssues({}); setError(null);
    const branding = { productName: productName.trim(), accent: accent.trim(), logoUrl: logoUrl.trim() };
    try {
      if (target.kind === "platform") {
        await apiFetch(`/api/tenants/${target.tenantId}`, { method: "PATCH", body: { branding } });
      } else {
        await apiFetch("/api/tenant/branding", { method: "PATCH", body: branding });
      }
      toast({ title: "Branding saved", description: "The new look applies on the next page load.", tone: "success" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const fe = fieldErrors(err);
        setIssues(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^branding\./, ""), v])));
        if (!Object.keys(fe).length) setError(err.message);
      } else setError(err instanceof Error ? err.message : "Could not save the branding.");
    } finally {
      setBusy(false);
    }
  }

  const swatch = HEX.test(accent) ? accent : "#4F46E5";

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-9 w-9 rounded-md object-contain" />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-md text-sm font-semibold text-white" style={{ background: swatch }}>
            {(productName || fallbackProductName).slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-display text-sm font-semibold">{productName || fallbackProductName}</p>
          <p className="font-mono text-[10px] text-muted-foreground">preview · accent {swatch}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Product name" htmlFor="br-product" hint={issues.productName ?? "Leave empty for ClinicMind"}>
          <Input id="br-product" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder={fallbackProductName} />
        </Field>
        <Field label="Accent colour" htmlFor="br-accent" hint={issues.accent ?? "Hex, e.g. #0F766E"}>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick accent colour"
              value={swatch}
              onChange={(e) => setAccent(e.target.value.toUpperCase())}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-background p-1"
            />
            <Input id="br-accent" value={accent} onChange={(e) => setAccent(e.target.value)} placeholder="#4F46E5" className="font-mono" />
          </div>
        </Field>
        <Field label="Logo URL" htmlFor="br-logo" hint={issues.logoUrl ?? "https · square works best"}>
          <Input id="br-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.svg" />
        </Field>
      </div>
      <Button type="submit" size="sm" disabled={busy}>
        <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save branding"}
      </Button>
    </form>
  );
}

/** Custom domain, verification flag, embed switch and allow-listed origins. */
export function DomainForm({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: { customDomain: string | null; customDomainVerified: boolean; embedEnabled: boolean; allowedOrigins: string[] };
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [customDomain, setCustomDomain] = useState(initial.customDomain ?? "");
  const [verified, setVerified] = useState(initial.customDomainVerified);
  const [embedEnabled, setEmbedEnabled] = useState(initial.embedEnabled);
  const [origins, setOrigins] = useState(initial.allowedOrigins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setIssues({}); setError(null);
    try {
      await apiFetch(`/api/tenants/${tenantId}`, {
        method: "PATCH",
        body: {
          customDomain: customDomain.trim() || null,
          customDomainVerified: verified,
          embedEnabled,
          allowedOrigins: origins.split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean),
        },
      });
      toast({ title: "Domain and embedding saved", tone: "success" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "domain_taken") setIssues({ customDomain: "This domain belongs to another tenant." });
      else if (err instanceof ApiError && err.status === 422) {
        const fe = fieldErrors(err);
        setIssues(fe);
        if (!Object.keys(fe).length) setError(err.message);
      } else setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <Field label="Custom domain" htmlFor="dm-domain" hint={issues.customDomain ?? "Point a CNAME at the platform host, then mark it verified"}>
        <Input id="dm-domain" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="app.nourclinics.com" />
      </Field>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={verified} onChange={(e) => setVerified(e.target.checked)} disabled={!customDomain.trim()} />
          DNS verified, serve on this domain
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={embedEnabled} onChange={(e) => setEmbedEnabled(e.target.checked)} />
          Embedding enabled
        </label>
      </div>
      <Field label="Allowed embedding origins" htmlFor="dm-origins" hint={issues.allowedOrigins ?? "One origin per line; an empty list refuses every embed token request"}>
        <Textarea id="dm-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} className="min-h-[4.5rem] font-mono text-xs" placeholder="https://www.nourclinics.com" />
      </Field>
      <Button type="submit" size="sm" disabled={busy}>
        <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save domain & embedding"}
      </Button>
    </form>
  );
}

/** Invite (or re-invite) the clinic owner; shows the single-use link to hand over. */
export function OwnerInviteForm({ tenantId, owner }: { tenantId: string; owner: { email: string; fullName: string | null; status: string } | null }) {
  const router = useRouter();
  const [email, setEmail] = useState(owner?.status === "INVITED" ? owner.email : "");
  const [fullName, setFullName] = useState(owner?.status === "INVITED" ? (owner.fullName ?? "") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; url: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await apiFetch<{ owner: { email: string }; inviteUrl: string }>(`/api/tenants/${tenantId}/owner`, {
        method: "POST",
        body: { email: email.trim(), fullName: fullName.trim() || undefined },
      });
      setResult({ email: res.owner.email, url: res.inviteUrl });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_taken") setError("That person already has an active account in this tenant.");
      else setError(err instanceof Error ? err.message : "Could not create the invitation.");
    } finally {
      setBusy(false);
    }
  }

  const reinvite = owner?.status === "INVITED" && email.trim().toLowerCase() === owner.email.toLowerCase();

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      {result ? <CopyField label={`Invitation for ${result.email} · valid 7 days`} value={result.url} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Owner e-mail" htmlFor="ow-email">
          <Input id="ow-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Full name" htmlFor="ow-name">
          <Input id="ow-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" size="sm" disabled={busy || !email.trim()}>
        <MailPlus className="h-4 w-4" /> {busy ? "Inviting…" : reinvite ? "Re-send invitation" : "Invite owner"}
      </Button>
    </form>
  );
}
