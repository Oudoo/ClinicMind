"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, MailPlus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field, inputClass } from "@/components/ui/field";

interface InviteResponse {
  error?: string;
  inviteUrl?: string;
  inviteExpiresAt?: string;
}

/**
 * Invite a staff member. The server e-mails the single-use link and also
 * returns it, so the administrator can hand it over in person when no mail
 * transport is configured.
 */
export function InviteMemberForm({ roles }: { roles: readonly string[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState(roles.includes("DOCTOR") ? "DOCTOR" : roles[0] ?? "");
  // Doctors sign by default; anyone else only when the owner says so.
  const [clinician, setClinician] = useState(role === "DOCTOR");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; url: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName: fullName.trim() || undefined, role, isClinician: clinician }),
      });
      const data = (await res.json().catch(() => ({}))) as InviteResponse;
      if (res.ok && data.inviteUrl) {
        setResult({ email, url: data.inviteUrl });
        setEmail("");
        setFullName("");
        router.refresh();
      } else if (data.error === "email_taken") {
        setError("A user with this e-mail already exists in this clinic.");
      } else if (data.error === "role_not_grantable") {
        setError("You cannot grant that role.");
      } else if (res.status === 403) {
        setError("You do not have permission to invite staff.");
      } else {
        setError("Check the e-mail address and try again.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      {result ? (
        <Alert tone="success" className="space-y-2">
          <p>
            Invitation created for <span className="font-medium">{result.email}</span>. It has been
            e-mailed (or logged, if no mail transport is configured) and you can also share this link
            directly. It expires in 7 days.
          </p>
          <InviteLink url={result.url} />
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="E-mail" htmlFor="invite-email">
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Full name" htmlFor="invite-name">
          <input
            id="invite-name"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <select
            id="invite-role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setClinician(e.target.value === "DOCTOR");
            }}
            className={inputClass}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={clinician}
          onChange={(e) => setClinician(e.target.checked)}
        />
        <span>
          Clinician
          <span className="block text-xs text-muted-foreground">May sign consultation notes and procedures (doctors and the physician-owner).</span>
        </span>
      </label>
      <Button type="submit" size="sm" disabled={pending || !email}>
        <MailPlus className="h-4 w-4" />
        {pending ? "Inviting…" : "Send invitation"}
      </Button>
    </form>
  );
}

/** Re-issue the invitation of a member who has not set a password yet. */
export function ResendInviteButton({ userId }: { userId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);

  async function resend() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const res = await fetch(`/api/users/${userId}/invite`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as InviteResponse;
      if (res.ok && data.inviteUrl) setUrl(data.inviteUrl);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="ghost" size="sm" onClick={resend} disabled={pending}>
        <RefreshCw className="h-3.5 w-3.5" />
        {pending ? "Sending…" : "Resend invite"}
      </Button>
      {url ? <InviteLink url={url} /> : null}
      {error ? <span className="text-xs text-danger">Could not resend.</span> : null}
    </div>
  );
}

function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="max-w-[18rem] truncate rounded bg-background px-2 py-1 font-mono text-[11px] text-foreground sm:max-w-md">
        {url}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * The clinician mark in the team table: whether this person may sign
 * clinical records. Nobody changes their own mark.
 */
export function ClinicianToggle({ userId, initial, self }: { userId: string; initial: boolean; self: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending || self) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isClinician: !value }),
      });
      if (res.ok) {
        setValue(!value);
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? "Could not change it.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={value ? "Clinician: may sign clinical records" : "Not a clinician: cannot sign"}
        onClick={toggle}
        disabled={pending || self}
        title={self ? "Another owner or the platform administrator changes your own mark" : undefined}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${value ? "bg-accent" : "bg-muted"}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-card shadow transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
      {error ? <span className="mt-1 text-xs text-danger">{error}</span> : null}
    </span>
  );
}
