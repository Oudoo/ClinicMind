import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        success: "border-transparent bg-emerald-100 text-emerald-800",
        warning: "border-transparent bg-amber-100 text-amber-800",
        info: "border-transparent bg-sky-100 text-sky-800",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

/** Status → badge variant mapping used across the app. */
export function statusVariant(status: string): BadgeProps["variant"] {
  if (["active", "connected", "completed", "approved", "verified", "done", "paid", "delivered", "resolved", "implemented", "scaled", "promoted"].includes(status)) return "success";
  if (["error", "failed", "rejected", "overdue", "token_expired", "past_due", "blocked", "urgent"].includes(status)) return "destructive";
  if (["syncing", "running", "in_progress", "analyzing", "transcribing", "crawling", "processing", "in_pilot", "pending", "queued", "awaiting_client_approval", "waiting_on_client"].includes(status)) return "warning";
  return "secondary";
}
