"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowRight, ChevronDown, RotateCcw, XCircle } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { STAGE_LABELS, moveTargets, type LeadStageKey } from "@/modules/crm/shared";
import { LostDialog, ReopenDialog, type LostTarget } from "./lead-lost-dialog";
import { crmErrorMessage } from "./lead-shared";

const item =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/**
 * "Move to" on a pipeline card (and beside the stepper on a lead's page):
 * the stages the pipeline allows from here, "Mark lost…" with its reason, or
 * "Reopen" for a lost lead. No drag and drop: one tap, one menu.
 */
export function LeadMoveMenu({ lead, className, label = "Move to" }: { lead: LostTarget; className?: string; label?: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<null | "lost" | "reopen">(null);
  const [busy, setBusy] = useState(false);
  const targets = moveTargets(lead.stage).filter((s) => s !== "LOST");

  async function move(stage: LeadStageKey) {
    setBusy(true);
    try {
      await apiFetch(`/api/leads/${lead.id}/stage`, { method: "POST", body: { stage } });
      toast({ title: `${lead.fullName} → ${STAGE_LABELS[stage]}`, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not move the lead", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const done = () => {
    setDialog(null);
    router.refresh();
  };

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-label={`${label} — ${lead.fullName}`}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              className,
            )}
          >
            {busy ? "Moving…" : label}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[13rem] rounded-lg border border-border bg-card p-1 shadow-lg animate-fade-in">
            {targets.length ? <DropdownMenu.Label className="px-2 py-1 data-label">Move to</DropdownMenu.Label> : null}
            {targets.map((stage) => (
              <DropdownMenu.Item key={stage} className={item} onSelect={() => void move(stage)}>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {STAGE_LABELS[stage]}
              </DropdownMenu.Item>
            ))}
            {lead.stage === "WON" ? <p className="px-2 py-1.5 text-xs text-muted-foreground">A won lead stays won.</p> : null}
            {lead.stage !== "LOST" && lead.stage !== "WON" ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item className={cn(item, "text-danger data-[highlighted]:bg-danger/5")} onSelect={() => setDialog("lost")}>
                  <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Mark lost…
                </DropdownMenu.Item>
              </>
            ) : null}
            {lead.stage === "LOST" ? (
              <DropdownMenu.Item className={item} onSelect={() => setDialog("reopen")}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Reopen…
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dialog === "lost" ? <LostDialog lead={lead} onOpenChange={(o) => !o && setDialog(null)} onDone={done} /> : null}
      {dialog === "reopen" ? <ReopenDialog lead={lead} onOpenChange={(o) => !o && setDialog(null)} onDone={done} /> : null}
    </>
  );
}
