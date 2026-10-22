"use client";

import { useEffect, useState } from "react";
import { AssistantChat } from "@/components/clinicmind/assistant-chat";
import { Activity } from "lucide-react";

type Phase = "checking" | "awaiting-token" | "ready" | "denied";

/**
 * Boots an embedded ClinicMind session inside an iframe.
 *
 * 1. Probe /api/me — an embed cookie from a previous exchange may still be valid.
 * 2. Otherwise ask the host page for a token via postMessage and exchange it for
 *    an httpOnly cookie at /api/embed/session.
 * 3. Render the tenant-scoped surface once authenticated.
 *
 * Only the tenant's allow-listed origins are spoken to: the token request is
 * posted to each allowed origin (the browser delivers it only to the matching
 * parent) and token messages are accepted only from an allowed origin and from
 * the parent window (SEC-7).
 */
export function EmbedBootstrap({
  tenantSlug,
  productName,
  allowedOrigins,
}: {
  tenantSlug: string;
  productName: string;
  allowedOrigins: string[];
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [reason, setReason] = useState<string | null>(null);
  const [tenantName, setTenantName] = useState<string>(tenantSlug);

  useEffect(() => {
    let cancelled = false;

    async function probe(): Promise<boolean> {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        if (!res.ok) return false;
        const data = await res.json();
        if (!cancelled) setTenantName(data.tenant?.name ?? tenantSlug);
        return true;
      } catch {
        return false;
      }
    }

    async function exchange(token: string) {
      try {
        const res = await fetch("/api/embed/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error("exchange failed");
        if (await probe()) {
          if (!cancelled) setPhase("ready");
        } else if (!cancelled) {
          deny("The token could not be verified.");
        }
      } catch {
        if (!cancelled) deny("The token could not be verified.");
      }
    }

    function deny(why: string) {
      setReason(why);
      setPhase("denied");
    }

    function onMessage(e: MessageEvent) {
      if (e.source !== window.parent) return;
      if (!allowedOrigins.includes(e.origin)) return;
      if (e.data?.type === "clinicmind:token" && typeof e.data.token === "string") {
        void exchange(e.data.token);
      }
    }

    (async () => {
      if (await probe()) {
        if (!cancelled) setPhase("ready");
        return;
      }
      if (window.parent === window) {
        if (!cancelled) deny("This surface must be embedded by the clinic's website.");
        return;
      }
      if (allowedOrigins.length === 0) {
        if (!cancelled) deny("No embedding origins are configured for this clinic.");
        return;
      }
      window.addEventListener("message", onMessage);
      for (const origin of allowedOrigins) {
        window.parent.postMessage({ type: "clinicmind:request-token", tenant: tenantSlug }, origin);
      }
      if (!cancelled) setPhase("awaiting-token");
      // Give the host a moment, then mark denied if nothing arrives.
      setTimeout(() => {
        if (!cancelled) {
          setPhase((p) => {
            if (p === "awaiting-token") setReason("The host page did not provide an embed token.");
            return p === "awaiting-token" ? "denied" : p;
          });
        }
      }, 8000);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [tenantSlug, allowedOrigins]);

  if (phase === "ready") {
    return (
      <div className="flex h-screen flex-col bg-background">
        <header className="flex h-12 items-center gap-2 border-b border-border bg-card px-4">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-indigo-flow text-white">
            <Activity className="h-3.5 w-3.5" />
          </div>
          <span className="font-display text-sm font-semibold">{productName}</span>
          <span className="font-mono text-[10px] text-muted-foreground">· {tenantName}</span>
        </header>
        <div className="flex-1 overflow-hidden p-3">
          <AssistantChat />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-center">
      <div className="flex h-10 w-10 animate-pulse-spike items-center justify-center rounded-lg bg-indigo-flow text-white">
        <Activity className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium">
        {phase === "denied" ? "Session could not be established" : "Connecting…"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {phase === "denied"
          ? (reason ?? "Verify the embed secret, the user id being minted for, and the allowed origins.")
          : "Authenticating your clinic session."}
      </p>
    </div>
  );
}
