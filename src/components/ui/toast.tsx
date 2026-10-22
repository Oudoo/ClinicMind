"use client";

import * as React from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lightweight toast notifications. Mount <ToastProvider> once (dashboard
 * layout) and call `useToast().toast({ title, tone })` from client components.
 */
type Tone = "success" | "danger" | "info";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastApi {
  toast: (t: { title: string; description?: string; tone?: Tone; durationMs?: number }) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const dismiss = React.useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const api = React.useMemo<ToastApi>(
    () => ({
      toast: ({ title, description, tone = "info", durationMs = 4000 }) => {
        const id = Date.now() + Math.random();
        setItems((xs) => [...xs, { id, title, description, tone }]);
        window.setTimeout(() => dismiss(id), durationMs);
      },
    }),
    [dismiss],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = item.tone === "success" ? CheckCircle2 : item.tone === "danger" ? AlertCircle : Info;
  const color = item.tone === "success" ? "text-success" : item.tone === "danger" ? "text-danger" : "text-accent";
  return (
    <div
      role={item.tone === "danger" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-lg animate-fade-in",
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {item.description ? <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p> : null}
      </div>
      <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
