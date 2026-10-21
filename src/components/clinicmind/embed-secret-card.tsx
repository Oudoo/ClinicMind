"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";

interface Props {
  /** Non-secret identifier of the live secret, e.g. `cmembed_ab12cd`. */
  secretPrefix: string | null;
  /** ISO timestamp of the last (re)generation. */
  rotatedAt: string | null;
  /** Whether the acting user may generate/rotate (embed:manage). */
  canRotate: boolean;
}

/**
 * Shows which embed secret is live and lets an owner generate or rotate it.
 * The plaintext is only ever displayed in the response to a rotation, once;
 * reloading the page shows the prefix again, never the secret.
 */
export function EmbedSecretCard({ secretPrefix, rotatedAt, canRotate }: Props) {
  const [live, setLive] = useState({ secretPrefix, rotatedAt });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function rotate() {
    const verb = live.secretPrefix ? "Rotate" : "Generate";
    if (
      live.secretPrefix &&
      !window.confirm(
        "Rotate the embed secret? Integrations still using the current secret will stop minting sessions immediately.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/embed/secret", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${verb} failed (${res.status})`);
      }
      const data = (await res.json()) as { secret: string; prefix: string; rotatedAt: string };
      setRevealed(data.secret);
      setLive({ secretPrefix: data.prefix, rotatedAt: data.rotatedAt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <span className="data-label">Embed secret</span>
          {live.secretPrefix ? (
            <span className="font-mono text-xs">{live.secretPrefix}…</span>
          ) : (
            <Badge tone="warning">not generated</Badge>
          )}
          {live.rotatedAt ? (
            <span className="text-xs text-muted-foreground">
              since {new Date(live.rotatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            </span>
          ) : null}
        </div>
        {canRotate ? (
          <Button variant="outline" size="sm" onClick={rotate} disabled={busy} type="button">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {live.secretPrefix ? "Rotate secret" : "Generate secret"}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        Your backend presents this secret to <span className="font-mono">POST /api/embed/token</span> to
        mint sessions. It is stored hashed and shown only once, right after it is generated.
      </p>

      {revealed ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-xs font-medium text-warning">
            Copy it now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">{revealed}</code>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(revealed);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
