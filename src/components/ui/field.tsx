import * as React from "react";
import { cn } from "@/lib/utils";

/** Shared text-input styling for forms (sign-in, invitations, settings). */
export const inputClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="data-label block">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Alert({
  tone = "danger",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: "danger" | "success" | "info" }) {
  const tones = {
    danger: "border-danger/30 bg-danger/5 text-danger",
    success: "border-success/30 bg-success/5 text-success",
    info: "border-border bg-muted text-muted-foreground",
  };
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("rounded-lg border px-3 py-2 text-sm", tones[tone], className)}
      {...props}
    />
  );
}
