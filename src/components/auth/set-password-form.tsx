"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Field, inputClass } from "@/components/ui/field";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";

/**
 * Chooses a password for an invitation or reset token and signs the user in.
 * Used by /invite/[token] and /reset-password/[token].
 */
export function SetPasswordForm({ token, kind }: { token: string; kind: "INVITE" | "PASSWORD_RESET" }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; redirectTo?: string };
      if (res.ok) {
        window.location.assign(data.redirectTo ?? "/dashboard");
        return;
      }
      if (data.error === "expired_token" || data.error === "used_token" || data.error === "invalid_token") {
        setError("This link is no longer valid. Request a new one from the sign-in page.");
      } else if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes before trying again.");
      } else {
        setError(`Choose a password of ${PASSWORD_MIN_LENGTH} to 128 characters.`);
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
      <Field label="New password" htmlFor="password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving…" : kind === "INVITE" ? "Set password and sign in" : "Change password"}
      </Button>
    </form>
  );
}
