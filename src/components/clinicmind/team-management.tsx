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
        body: JSON.stringify({ email, fullName: fullName.trim() || undefined, role }),
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
            onChange={(e) => setRole(e.target.value)}
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
