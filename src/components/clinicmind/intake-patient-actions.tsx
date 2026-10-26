"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NewIntakeLinkDialog, type FixedPatient } from "@/components/clinicmind/intake-link-dialog";

/** "Send onboarding link" on the patient page: creates a PATIENT link and shows the URL, QR and WhatsApp share. */
export function SendIntakeLinkButton({ patient }: { patient: FixedPatient }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Send className="h-4 w-4" />
        Send onboarding link
      </Button>
      <NewIntakeLinkDialog open={open} onOpenChange={setOpen} fixedPatient={patient} />
    </>
  );
}
