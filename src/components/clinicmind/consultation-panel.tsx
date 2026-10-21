"use client";

import { useState } from "react";
import { Mic, Square, ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";

interface Extraction {
  symptoms: string[];
  diagnoses: string[];
  medications: { name: string; dosage?: string; frequency?: string }[];
  tests: string[];
  followUps: string[];
}

/**
 * Consultation Intelligence capture.
 *
 * Flow: record/paste transcript -> AI extracts structured clinical data ->
 * clinician REVIEWS -> explicitly signs. Clinical decisions are never auto-saved.
 */
export function ConsultationPanel({ patients }: { patients: { id: string; fullName: string }[] }) {
  const [patientId, setPatientId] = useState(patients[0]?.id ?? "");
  const [transcript, setTranscript] = useState("");
  const [recording, setRecording] = useState(false);
  const [phase, setPhase] = useState<"idle" | "extracting" | "review" | "signed">("idle");
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [summary, setSummary] = useState("");
  const [consultationId, setConsultationId] = useState<string | null>(null);

  async function runExtraction() {
    if (!transcript.trim() || !patientId) return;
    setPhase("extracting");
    const res = await fetch("/api/consultations/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId, transcript }),
    });
    const data = await res.json();
    setExtraction(data.extraction);
    setSummary(data.summary ?? "");
    setConsultationId(data.consultationId ?? null);
    setPhase("review");
  }

  async function sign() {
    if (!consultationId) return;
    await fetch(`/api/consultations/${consultationId}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction, summary }),
    });
    setPhase("signed");
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="space-y-4">
        <SectionTitle title="Capture" description="Record audio or paste the consultation transcript." />
        <select
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <Button
            variant={recording ? "danger" : "outline"}
            onClick={() => setRecording((r) => !r)}
            type="button"
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            {recording ? "Stop" : "Record"}
          </Button>
          {recording ? <Badge tone="danger">● transcribing</Badge> : null}
        </div>

        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={10}
          placeholder="Transcript appears here as you speak, or paste it manually…"
          className="w-full rounded-lg border border-input bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />

        <Button onClick={runExtraction} disabled={!transcript.trim() || phase === "extracting"}>
          {phase === "extracting" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Extract clinical data
        </Button>
      </Card>

      <Card className="space-y-4">
        <SectionTitle
          title="Review & Sign"
          description="AI-extracted data. Edit before signing — nothing is saved automatically."
        />
        {phase === "idle" || phase === "extracting" ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {phase === "extracting" ? "Extracting…" : "Run extraction to review structured output."}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <Field label="Symptoms" items={extraction?.symptoms ?? []} />
            <Field label="Diagnoses" items={extraction?.diagnoses ?? []} />
            <Field
              label="Medications"
              items={(extraction?.medications ?? []).map(
                (m) => `${m.name}${m.dosage ? ` · ${m.dosage}` : ""}${m.frequency ? ` · ${m.frequency}` : ""}`,
              )}
            />
            <Field label="Tests" items={extraction?.tests ?? []} />
            <Field label="Follow-ups" items={extraction?.followUps ?? []} />

            <div>
              <p className="data-label mb-1">Visit summary</p>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-input bg-background p-3 text-sm"
              />
            </div>

            {phase === "signed" ? (
              <Badge tone="success">
                <ShieldCheck className="h-3 w-3" /> Signed & saved to patient record
              </Badge>
            ) : (
              <Button onClick={sign} disabled={phase !== "review"}>
                <ShieldCheck className="h-4 w-4" />
                Review complete — sign
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="data-label mb-1">{label}</p>
      {items.length ? (
        <div className="flex flex-wrap gap-1">
          {items.map((it, i) => (
            <Badge key={i} tone="accent">
              {it}
            </Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
}
