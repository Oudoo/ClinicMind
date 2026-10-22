import type { ConsultationStatus } from "@prisma/client";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, formatTime } from "@/lib/utils";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";

/** One row of the "Visits & consultations" tab: a visit, or a consultation not (yet) signed into one. */
export interface VisitRow {
  id: string;
  kind: "visit" | "consultation";
  date: Date;
  doctor: string | null;
  summary: string | null;
  status: ConsultationStatus | null;
}

const STATUS_TONE: Record<ConsultationStatus, BadgeTone> = {
  RECORDING: "accent",
  TRANSCRIBING: "accent",
  EXTRACTING: "accent",
  PENDING_REVIEW: "warning",
  SIGNED: "success",
  DISCARDED: "danger",
};

function excerpt(text: string | null, max = 140): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Read-only table of visits and consultations. Server component; wrap in a padding-less Card. */
export function PatientVisitsTable({ rows }: { rows: VisitRow[] }) {
  if (!rows.length) {
    return (
      <div className="p-6">
        <EmptyState
          title="No visits yet"
          hint="Signed consultations create visits; pending ones are listed here too."
        />
      </div>
    );
  }
  return (
    <Table>
      <THead>
        <TR className="hover:bg-transparent">
          <TH>Date</TH>
          <TH>Doctor</TH>
          <TH>Summary</TH>
          <TH>Status</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.id}>
            <TD className="whitespace-nowrap font-mono text-xs tabular-nums">
              {formatDate(row.date)}{" "}
              <span className="text-muted-foreground">{formatTime(row.date)}</span>
            </TD>
            <TD className="whitespace-nowrap text-sm">{row.doctor ?? <span className="text-muted-foreground">—</span>}</TD>
            <TD className="min-w-[16rem] max-w-md text-sm text-muted-foreground">
              {excerpt(row.summary) ?? <span className="italic">No summary</span>}
            </TD>
            <TD>
              {row.status ? (
                <Badge tone={STATUS_TONE[row.status]}>{row.status.replace("_", " ")}</Badge>
              ) : (
                <Badge>visit</Badge>
              )}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
