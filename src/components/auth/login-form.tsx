"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field, inputClass } from "@/components/ui/field";
import { announceAuthChange } from "@/lib/auth/browser-session";

/** E-mail + password sign-in. Posts to /api/auth/login and follows `redirectTo`. */
export function LoginForm({ next, tenantHint }: { next: string | null; tenantHint: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenant, setTenant] = useState(tenantHint);
  const [askTenant, setAskTenant] = useState(Boolean(tenantHint));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          tenant: tenant.trim() || undefined,
          next: next ?? undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        retryAfterSeconds?: number;
        redirectTo?: string;
      };
      if (res.ok) {
        announceAuthChange("signed-in");
        window.location.assign(data.redirectTo ?? "/dashboard");
        return;
      }
      if (data.error === "tenant_required") {
        setAskTenant(true);
        setError("This e-mail is registered with more than one clinic. Enter your clinic ID to continue.");
      } else if (res.status === 429) {
        const minutes = Math.max(1, Math.ceil((data.retryAfterSeconds ?? 60) / 60));
        setError(
          data.error === "account_locked"
            ? `Too many failed sign-ins. This account is locked for about ${minutes} min.`
            : `Too many attempts. Try again in about ${minutes} min.`,
        );
      } else if (res.status === 422) {
        setError("Enter a valid e-mail address and your password.");
      } else {
        setError("Incorrect e-mail or password.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}

      <Field label="E-mail" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </Field>

      {askTenant ? (
        <Field
          label="Clinic ID"
          htmlFor="tenant"
          hint="The short name of your clinic in ClinicMind, e.g. the subdomain you normally use."
        >
          <input
            id="tenant"
            name="tenant"
            type="text"
            autoComplete="organization"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            className={inputClass}
          />
        </Field>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending}>
        <LogIn className="h-4 w-4" />
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        <Link href="/forgot-password" className="hover:text-accent">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
