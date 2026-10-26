"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Copy, MessageCircle, Plus, QrCode, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { formatDateInTz } from "@/lib/time";
import type { IntakeLinkDTO, IntakeLinkStatus, IssuedIntakeLink } from "@/modules/intake/service";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";
import { apiErrorMessage } from "@/components/clinicmind/patient-shared";
import { IntakeLinkResult, NewIntakeLinkDialog, useCopy } from "@/components/clinicmind/intake-link-dialog";

const STATUS_TONE: Record<IntakeLinkStatus, BadgeTone> = {
  active: "success",
  expired: "default",
  revoked: "danger",
  exhausted: "warning",
};

/**
 * The "Links" tab: every onboarding link with its uses and status. The URL
 * and QR of a link exist only at creation (the database keeps a hash), so
 * copy / QR / WhatsApp are offered for links created in this session and
 * "Re-issue" mints a fresh link with the same settings for older ones.
 */
export function IntakeLinksTable({ links, timezone }: { links: IntakeLinkDTO[]; timezone: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const { copy } = useCopy();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Record<string, IssuedIntakeLink>>({});
  const [showQr, setShowQr] = useState<IssuedIntakeLink | null>(null);
  const [revoking, setRevoking] = useState<IntakeLinkDTO | null>(null);
  const [reissuing, setReissuing] = useState<IntakeLinkDTO | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = [...Object.values(issued).map((i) => i.link).filter((l) => !links.some((x) => x.id === l.id)), ...links];

  async function revoke(link: IntakeLinkDTO) {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/intake/links/${link.id}/revoke`, { method: "POST" });
      toast({ title: "Link revoked", description: link.label ?? link.tokenPrefix, tone: "success" });
      setRevoking(null);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not revoke the link", description: apiErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const date = (iso: string) => formatDateInTz(new Date(iso), timezone);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {links.length} {links.length === 1 ? "link" : "links"} · the URL and QR are shown once, when a link is created.
        </p>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New link
        </Button>
      </div>

      {rows.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Link</TH>
                <TH className="hidden md:table-cell">Kind</TH>
                <TH className="hidden lg:table-cell">Created by</TH>
                <TH className="hidden lg:table-cell">Expires</TH>
                <TH className="hidden md:table-cell">Uses</TH>
                <TH className="hidden md:table-cell">Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((link) => {
                const one = issued[link.id];
                return (
                  <TR key={link.id}>
                    <TD>
                      <div className="font-medium">{link.label ?? (link.kind === "PATIENT" ? "Personal link" : "Open link")}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {link.tokenPrefix}… · {date(link.createdAt)}
                      </div>
                      {/* Phones: kind, uses and status live here so the actions stay on screen. */}
                      <div className="mt-1.5 space-y-1 text-xs text-muted-foreground md:hidden">
                        <div>
                          {link.kind === "PATIENT" && link.patient ? (
                            <Link href={`/dashboard/patients/${link.patient.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                              {link.patient.fullName}
                            </Link>
                          ) : (
                            "Open link"
                          )}{" "}
                          · {link.language === "ar" ? "Arabic" : "English"}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={STATUS_TONE[link.status]}>{link.status}</Badge>
                          <span className="font-mono tabular-nums">
                            {link.uses}
                            {link.maxUses ? ` / ${link.maxUses}` : ""} used · {link.submissionCount} {link.submissionCount === 1 ? "form" : "forms"}
                          </span>
                        </div>
                      </div>
                    </TD>
                    <TD className="hidden md:table-cell">
                      {link.kind === "PATIENT" && link.patient ? (
                        <Link href={`/dashboard/patients/${link.patient.id}`} className="text-sm underline-offset-2 hover:text-accent hover:underline">
                          {link.patient.fullName}
                        </Link>
                      ) : (
                        <Badge>{link.kind === "OPEN" ? "Open" : "Patient"}</Badge>
                      )}
                      <div className="text-[11px] text-muted-foreground">{link.language === "ar" ? "Arabic" : "English"}</div>
                    </TD>
                    <TD className="hidden text-sm text-muted-foreground lg:table-cell">{link.createdBy?.fullName ?? "—"}</TD>
                    <TD className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground lg:table-cell">{date(link.expiresAt)}</TD>
                    <TD className="hidden font-mono text-xs tabular-nums md:table-cell">
                      {link.uses}
                      {link.maxUses ? ` / ${link.maxUses}` : ""}
                      <div className="text-[11px] text-muted-foreground">
                        {link.submissionCount} {link.submissionCount === 1 ? "form" : "forms"}
                      </div>
                    </TD>
                    <TD className="hidden md:table-cell">
                      <Badge tone={STATUS_TONE[link.status]}>{link.status}</Badge>
                    </TD>
                    <TD className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {one ? (
                          <>
                            <Button type="button" variant="ghost" size="sm" onClick={() => void copy(one.url)} aria-label="Copy link" title="Copy link">
                              <Copy className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setShowQr(one)} aria-label="Show QR" title="Show QR">
                              <QrCode className="h-4 w-4" />
                            </Button>
                            <Button asChild variant="ghost" size="sm">
                              <a href={one.whatsappUrl} target="_blank" rel="noopener noreferrer" aria-label="Share on WhatsApp" title="Share on WhatsApp">
                                <MessageCircle className="h-4 w-4" />
                              </a>
                            </Button>
                          </>
                        ) : null}
                        {link.status === "active" ? (
                          <>
                            {!one ? (
                              <Button type="button" variant="ghost" size="sm" onClick={() => setReissuing(link)} title="Create a fresh link with the same settings and revoke this one">
                                <RefreshCw className="h-4 w-4" />
                                Re-issue
                              </Button>
                            ) : null}
                            <Button type="button" variant="ghost" size="sm" className="text-danger hover:bg-danger/10" onClick={() => setRevoking(link)} aria-label="Revoke link" title="Revoke link">
                              <Ban className="h-4 w-4" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      ) : (
        <EmptyState title="No onboarding links yet" hint="Create one for the reception desk (print its QR) or send a personal link from a patient's page." />
      )}

      <NewIntakeLinkDialog open={creating} onOpenChange={setCreating} onIssued={(i) => setIssued((m) => ({ ...m, [i.link.id]: i }))} />

      {reissuing ? (
        <NewIntakeLinkDialog
          open
          onOpenChange={(o) => (o ? undefined : setReissuing(null))}
          defaults={{
            kind: reissuing.kind,
            label: reissuing.label ?? undefined,
            language: reissuing.language,
            maxUses: reissuing.maxUses,
            patient: reissuing.patient ? { id: reissuing.patient.id, fullName: reissuing.patient.fullName, phone: reissuing.patient.phone } : null,
          }}
          onIssued={(i) => {
            setIssued((m) => ({ ...m, [i.link.id]: i }));
            void apiFetch(`/api/intake/links/${reissuing.id}/revoke`, { method: "POST" })
              .then(() => router.refresh())
              .catch(() => toast({ title: "The old link could not be revoked", tone: "danger" }));
          }}
        />
      ) : null}

      {showQr ? (
        <Dialog open onOpenChange={(o) => (o ? undefined : setShowQr(null))}>
          <DialogContent title={showQr.link.label ?? "Onboarding link"} description="Print the QR for the desk or copy the link." className="max-w-xl">
            <IntakeLinkResult issued={showQr} />
          </DialogContent>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => (o ? undefined : setRevoking(null))}
        title="Revoke this link?"
        description={`${revoking?.label ?? "The link"} stops working immediately; forms already submitted are kept.`}
        confirmLabel="Revoke link"
        tone="danger"
        busy={busy}
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      />
    </div>
  );
}
