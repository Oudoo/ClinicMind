"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Check, Copy, KeyRound, Link2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";

export const TIMEZONES = [
  "Africa/Cairo",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Qatar",
  "Asia/Kuwait",
  "Asia/Bahrain",
  "Asia/Amman",
  "Asia/Beirut",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "UTC",
] as const;

interface ProvisionResponse {
  tenant: { id: string; slug: string; name: string };
  owner: { id: string; email: string };
  inviteUrl: string;
  inviteExpiresAt: string;
  embedSecret: string;
}

/** `Nour Clinics` → `nour-clinics` */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Create a client tenant from the platform console. On success the dialog
 * shows what the platform administrator must hand over: the owner's
 * invitation link and the embed secret, which is never shown again.
 */
export function NewTenantDialog({ rootDomain, scheme }: { rootDomain: string; scheme: "http" | "https" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [productName, setProductName] = useState("");
  const [accent, setAccent] = useState("#4F46E5");
  const [logoUrl, setLogoUrl] = useState("");
  const [timezone, setTimezone] = useState<string>(TIMEZONES[0]);
  const [customDomain, setCustomDomain] = useState("");
  const [origins, setOrigins] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ProvisionResponse | null>(null);

  function reset() {
    setName(""); setSlug(""); setSlugTouched(false); setOwnerEmail(""); setOwnerFullName("");
    setProductName(""); setAccent("#4F46E5"); setLogoUrl(""); setTimezone(TIMEZONES[0]);
    setCustomDomain(""); setOrigins(""); setError(null); setIssues({}); setResult(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      if (result) router.refresh();
      reset();
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setIssues({});
    try {
      const allowedOrigins = origins.split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean);
      const body = {
        name: name.trim(),
        slug: slug || slugify(name),
        ownerEmail: ownerEmail.trim(),
        ownerFullName: ownerFullName.trim() || undefined,
        timezone,
        branding: {
          productName: productName.trim() || name.trim(),
          accent,
          logoUrl: logoUrl.trim() || undefined,
        },
        customDomain: customDomain.trim() || undefined,
        allowedOrigins: allowedOrigins.length ? allowedOrigins : undefined,
      };
      const res = await apiFetch<ProvisionResponse>("/api/tenants", { method: "POST", body });
      setResult(res);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "slug_taken") setIssues({ slug: "This slug is already in use." });
      else if (err instanceof ApiError && err.code === "slug_reserved") setIssues({ slug: "This slug is reserved." });
      else if (err instanceof ApiError && err.code === "domain_taken") setIssues({ customDomain: "This domain belongs to another tenant." });
      else if (err instanceof ApiError && err.status === 422) {
        const fe = fieldErrors(err);
        setIssues(fe);
        if (!Object.keys(fe).length) setError(err.message);
      } else setError(err instanceof Error ? err.message : "Could not create the tenant.");
    } finally {
      setBusy(false);
    }
  }

  const effectiveSlug = slug || slugify(name);
  const subdomainUrl = effectiveSlug ? `${scheme}://${effectiveSlug}.${rootDomain}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button type="button" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New tenant
      </Button>
      <DialogContent
        className="max-w-2xl"
        title={result ? `${result.tenant.name} is ready` : "New tenant"}
        description={
          result
            ? "Hand these over to the client. The embed secret is shown only now; the invitation link expires in 7 days."
            : "One client clinic group: its own users, data, branding, domain and embed credentials."
        }
      >
        {result ? (
          <div className="space-y-4">
            <CopyField label="Sign-in address" icon={Building2} value={`${scheme}://${result.tenant.slug}.${rootDomain}/login`} />
            <CopyField label={`Owner invitation · ${result.owner.email}`} icon={Link2} value={result.inviteUrl} />
            <CopyField label="Embed secret (shown once, stored hashed)" icon={KeyRound} value={result.embedSecret} secret />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button asChild>
                <Link href={`/platform/tenants/${result.tenant.id}`}>Open tenant</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Clinic / client name" htmlFor="nt-name" hint={issues.name}>
                <Input
                  id="nt-name"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                  placeholder="Nour Clinics"
                />
              </Field>
              <Field label="Slug (subdomain)" htmlFor="nt-slug" hint={issues.slug ?? (subdomainUrl ? subdomainUrl : "lowercase letters, digits, dashes")}>
                <Input
                  id="nt-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(slugify(e.target.value));
                  }}
                  placeholder="nour-clinics"
                />
              </Field>
              <Field label="Owner e-mail" htmlFor="nt-owner-email" hint={issues.ownerEmail}>
                <Input id="nt-owner-email" type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="dr.nour@nourclinics.com" />
              </Field>
              <Field label="Owner full name" htmlFor="nt-owner-name" hint={issues.ownerFullName}>
                <Input id="nt-owner-name" value={ownerFullName} onChange={(e) => setOwnerFullName(e.target.value)} placeholder="Dr. Nour Hassan" />
              </Field>
            </div>

            <p className="data-label">White-label</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Product name" htmlFor="nt-product" hint={issues["branding.productName"] ?? "Shown in the app header; defaults to the clinic name"}>
                <Input id="nt-product" value={productName} onChange={(e) => setProductName(e.target.value)} placeholder={name || "ClinicMind"} />
              </Field>
              <Field label="Accent colour" htmlFor="nt-accent" hint={issues["branding.accent"]}>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick accent colour"
                    value={/^#[0-9a-fA-F]{6}$/.test(accent) ? accent : "#4F46E5"}
                    onChange={(e) => setAccent(e.target.value.toUpperCase())}
                    className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-background p-1"
                  />
                  <Input id="nt-accent" value={accent} onChange={(e) => setAccent(e.target.value)} className="font-mono" />
                </div>
              </Field>
              <Field label="Logo URL" htmlFor="nt-logo" hint={issues["branding.logoUrl"] ?? "Optional · https"}>
                <Input id="nt-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.svg" />
              </Field>
            </div>

            <p className="data-label">Operations</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Clinic time zone" htmlFor="nt-tz" hint={issues.timezone}>
                <Select id="nt-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Custom domain" htmlFor="nt-domain" hint={issues.customDomain ?? "Optional · verified after DNS points here"}>
                <Input id="nt-domain" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="app.nourclinics.com" />
              </Field>
            </div>
            <Field label="Allowed embedding origins" htmlFor="nt-origins" hint={issues.allowedOrigins ?? "Optional · one origin per line, e.g. https://www.nourclinics.com"}>
              <Textarea id="nt-origins" value={origins} onChange={(e) => setOrigins(e.target.value)} className="min-h-[4.5rem] font-mono text-xs" />
            </Field>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim() || !ownerEmail.trim()}>
                <Building2 className="h-4 w-4" /> {busy ? "Creating…" : "Create tenant"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A read-only value with a copy button; `secret` renders it in monospace without wrapping. */
export function CopyField({
  label,
  value,
  icon: Icon,
  secret = false,
}: {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="data-label flex items-center gap-1.5">
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          {label}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code className={secret ? "block overflow-x-auto whitespace-nowrap font-mono text-xs" : "block break-all font-mono text-xs"}>{value}</code>
    </div>
  );
}
