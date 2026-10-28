"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { RecordPaymentDialog } from "./payment-record-dialog";
import { RecordProcedureDialog } from "./procedure-record-dialog";
import { ImportPosDialog } from "./payment-import-dialog";
import type { DoctorOption, PriceOption, ProcedureChoice, TreatmentOption } from "./finance-shared";

type Open = null | "payment" | "procedure" | "import";

/**
 * The finance dashboard's actions: record a payment, record a procedure and
 * import a POS export. Each refreshes the page when it is done.
 */
export function FinanceActions({
  timezone,
  treatments,
  priceItems = [],
  doctors,
  canPay,
  canRecordProcedure,
}: {
  timezone: string;
  treatments: TreatmentOption[];
  priceItems?: PriceOption[];
  doctors: DoctorOption[];
  canPay: boolean;
  canRecordProcedure: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState<Open>(null);
  const close = (v: boolean) => {
    if (!v) setOpen(null);
  };
  const done = (title: string, description?: string) => {
    setOpen(null);
    toast({ tone: "success", title, description });
    router.refresh();
  };

  if (!canPay && !canRecordProcedure) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {canPay ? (
        <Button size="sm" onClick={() => setOpen("payment")}>
          <Receipt className="h-4 w-4" aria-hidden="true" />
          Record payment
        </Button>
      ) : null}
      {canRecordProcedure ? (
        <Button size="sm" variant="outline" onClick={() => setOpen("procedure")}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Record procedure
        </Button>
      ) : null}
      {canPay ? (
        <Button size="sm" variant="outline" onClick={() => setOpen("import")}>
          <FileUp className="h-4 w-4" aria-hidden="true" />
          Import POS CSV
        </Button>
      ) : null}
      {open === "payment" ? <RecordPaymentDialog timezone={timezone} onOpenChange={close} onDone={() => done("Payment recorded")} /> : null}
      {open === "procedure" ? (
        <RecordProcedureDialog timezone={timezone} treatments={treatments} priceItems={priceItems} doctors={doctors} canDeposit={canPay} onOpenChange={close} onDone={() => done("Procedure recorded", "Planned until a clinician signs it.")} />
      ) : null}
      {open === "import" ? (
        <ImportPosDialog
          timezone={timezone}
          onOpenChange={close}
          onDone={(n, skipped) => done(`${n} ${n === 1 ? "payment" : "payments"} imported`, skipped ? `${skipped} already on file and skipped.` : undefined)}
        />
      ) : null}
    </div>
  );
}

/** "Record payment" for one patient owing money (the outstanding drill-down), prefilled with the oldest open balance. */
export function RecordPaymentForPatient({
  timezone,
  patient,
  procedures,
  label = "Record payment",
}: {
  timezone: string;
  patient: PatientOption;
  procedures: ProcedureChoice[];
  label?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const first = procedures.find((p) => p.balance > 0);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Receipt className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      {open ? (
        <RecordPaymentDialog
          timezone={timezone}
          patient={patient}
          procedures={procedures}
          defaults={{ kind: "PAYMENT", amount: first?.balance, procedureId: first?.id }}
          onOpenChange={(v) => setOpen(v)}
          onDone={() => {
            setOpen(false);
            toast({ tone: "success", title: "Payment recorded", description: patient.fullName });
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
