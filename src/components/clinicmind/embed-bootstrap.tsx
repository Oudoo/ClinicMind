"use client";

import { useEffect, useState } from "react";
import { AssistantChat } from "@/components/clinicmind/assistant-chat";
import { Activity } from "lucide-react";

type Phase = "checking" | "awaiting-token" | "ready" | "denied";

/**
 * Boots an embedded ClinicMind session inside an iframe.
 *
 * 1. Probe /api/me — a session may already exist (or dev demo fallback applies).
 * 2. Otherwise ask the host page for a token via postMessage and exchange it for
 *    an httpOnly cookie at /api/embed/session.
 * 3. Render the tenant-scoped surface once authenticated.
 */
export function EmbedBootstrap({ tenantSlug, productName }: { tenantSlug: string; productName: string }) {
  const [phase, setPhase] = useState<Phase>("checking");
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
          setPhase("denied");
        }
      } catch {
        if (!cancelled) setPhase("denied");
      }
    }

    function onMessage(e: MessageEvent) {
      if (e.data?.type === "clinicmind:token" && typeof e.data.token === "string") {
        void exchange(e.data.token);
      }
    }

    (async () => {
      if (await probe()) {
        if (!cancelled) setPhase("ready");
        return;
      }
      // Ask the host page for a token.
      window.addEventListener("message", onMessage);
      window.parent?.postMessage({ type: "clinicmind:request-token", tenant: tenantSlug }, "*");
      if (!cancelled) setPhase("awaiting-token");
      // Give the host a moment, then mark denied if nothing arrives.
      setTimeout(() => {
        if (!cancelled) setPhase((p) => (p === "awaiting-token" ? "denied" : p));
      }, 8000);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [tenantSlug]);

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
        {phase === "denied" ? "Session could not be established" : "Connecting to ClinicMind…"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {phase === "denied"
          ? "The host did not provide a valid embed token. Verify your integration key and allowed origins."
          : "Authenticating your tenant session."}
      </p>
    </div>
  );
}
