"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserMinus, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { RELATION_LABELS, RELATIONS, relationLabel, type RelationValue } from "@/modules/finance/ledger-copy";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { BalanceChip } from "./patient-balance";
import { financeErrorMessage } from "./finance-shared";

/** `GET /api/patients/[id]/household`, as the patient page hands it over. */
export interface FamilyView {
  role: "head" | "member" | "none";
  head: { id: string; fullName: string; archived: boolean; balance: number } | null;
  members: { id: string; fullName: string; relation: string | null; archived: boolean; balance: number }[];
  familyBalance: number | null;
}

type DialogMode = "join" | "add";

/**
 * The patient's family account: who pays for them, or whom they pay for,
 * with each one's balance and the family's together; the front desk puts a
 * patient in a family, adds a member or takes one out.
 */
export function FamilyAccount({ patient, household, canManage }: { patient: { id: string; fullName: string }; household: FamilyView; canManage: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [removing, setRemoving] = useState<{ id: string; fullName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const first = patient.fullName.split(/\s+/)[0] ?? patient.fullName;
  const head = household.head;

  async function remove(member: { id: string; fullName: string }) {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/patients/${member.id}/household`, { method: "PUT", body: { headId: null } });
      toast({ tone: "success", title: member.id === patient.id ? "Out of the family account" : `${member.fullName} is out of the family account`, description: "From now on they pay for themselves." });
      setRemoving(null);
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "That did not work", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const everyone = head ? [{ ...head, relation: null as string | null, isHead: true }, ...household.members.map((m) => ({ ...m, isHead: false }))] : [];

  return (
    <Card className="space-y-3" data-testid="family-account">
      <SectionTitle
        title="Family account"
        description={
          household.role === "member" && head
            ? `${head.fullName} pays for ${first}: their payments go towards ${first}'s invoices too.`
            : household.role === "head"
              ? `${first} pays for the family: payments go towards everyone's invoices, oldest first, after each member's own.`
              : `${first} pays for themselves.`
        }
      />

      {everyone.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {everyone.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                {m.id === patient.id ? (
                  <span className="font-medium">{m.fullName}</span>
                ) : (
                  <Link href={`/dashboard/patients/${m.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                    {m.fullName}
                  </Link>
                )}
                <span className="ms-2 text-xs text-muted-foreground">{m.isHead ? "Pays for the family" : (relationLabel(m.relation) ?? "Family")}</span>
                {m.archived ? <span className="ms-2 text-xs text-muted-foreground">(archived)</span> : null}
              </div>
              <div className="flex items-center gap-2">
                <BalanceChip balance={m.balance} showSettled />
                {canManage && !m.isHead && (household.role === "head" || m.id === patient.id) ? (
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setRemoving({ id: m.id, fullName: m.fullName })} aria-label={m.id === patient.id ? "Leave the family account" : `Take ${m.fullName} out of the family account`}>
                    <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                    {m.id === patient.id ? "Leave" : "Remove"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
          {household.familyBalance !== null ? (
            <li className="flex flex-wrap items-center justify-between gap-2 bg-muted/50 px-3 py-2 text-sm">
              <span className="font-medium">The family together</span>
              <BalanceChip balance={household.familyBalance} showSettled />
            </li>
          ) : null}
        </ul>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          {household.role !== "member" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setDialog("add")}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {household.role === "head" ? "Add a family member" : `${first} pays for a family member`}
            </Button>
          ) : null}
          {household.role === "none" ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setDialog("join")}>
              <Users className="h-4 w-4" aria-hidden="true" />
              Paid for by a family member
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog ? (
        <FamilyDialog
          mode={dialog}
          patient={patient}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onDone={(title) => {
            setDialog(null);
            toast({ tone: "success", title });
            router.refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing?.id === patient.id ? `Take ${first} out of the family account?` : `Take ${removing?.fullName ?? ""} out of the family account?`}
        description="What the family has paid so far stays where it went. From now on they pay for themselves."
        confirmLabel={removing?.id === patient.id ? "Leave the family" : "Remove from the family"}
        tone="danger"
        busy={busy}
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </Card>
  );
}

/**
 * Put the patient in a family: "join" chooses who pays for them, "add"
 * chooses a family member they pay for. The relation is the member's to the
 * one who pays.
 */
function FamilyDialog({ mode, patient, onOpenChange, onDone }: { mode: DialogMode; patient: { id: string; fullName: string }; onOpenChange: (open: boolean) => void; onDone: (title: string) => void }) {
  const id = useId();
  const [other, setOther] = useState<PatientOption | null>(null);
  const [relation, setRelation] = useState<RelationValue>(mode === "add" ? "CHILD" : "SPOUSE");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const join = mode === "join";
  // "Mariam Zaki is Hany Nabil's …" once both are known.
  const relationText = other ? `${join ? patient.fullName : other.fullName} is ${join ? other.fullName : patient.fullName}'s` : "Relation";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!other) {
      setIssues({ headId: join ? "Choose who pays." : "Choose the family member." });
      return;
    }
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      const memberId = join ? patient.id : other.id;
      const headId = join ? other.id : patient.id;
      await apiFetch(`/api/patients/${memberId}/household`, { method: "PUT", body: { headId, relation } });
      onDone(join ? `${other.fullName} pays for ${patient.fullName} now` : `${patient.fullName} pays for ${other.fullName} now`);
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={join ? `Who pays for ${patient.fullName}?` : `A family member ${patient.fullName} pays for`}
        description={join ? "Their payments will go towards this patient's invoices too." : "This patient's payments will go towards theirs too."}
        className="max-w-lg"
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <PatientPicker value={other} onChange={setOther} label={join ? "Paid for by" : "Family member"} excludeId={patient.id} error={issues.headId} />
          <Field label={relationText} htmlFor={`${id}-relation`} hint={issues.relation ? <span className="text-danger">{issues.relation}</span> : undefined}>
            <Select id={`${id}-relation`} value={relation} onChange={(e) => setRelation(e.target.value as RelationValue)}>
              {RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {RELATION_LABELS.en[r]}
                </option>
              ))}
            </Select>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
