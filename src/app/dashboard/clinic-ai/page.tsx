import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { aiStatus } from "@/lib/ai/provider";
import { aiConfigOf, publicAiConfig } from "@/lib/ai/tenant-config";
import { Card, SectionTitle, Badge } from "@/components/ui/primitives";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";

export const dynamic = "force-dynamic";

/**
 * The Clinic AI module as the clinic sees it: the spec's six modules with what
 * runs in this application today, what the click-through build shows, and the
 * phase that brings the rest. The AI lead account (ai@demo.clinic) and the
 * owner both land here; the module pages themselves live in the prototype
 * until their phase ships.
 */
const MODULES = [
  { n: "F", name: "Foundation", live: "One patient record, roles at every API edge, tenant isolation with row-level security, append-only audit, AI that answers only from the record", proto: "Modes per module, roles, delivery plan, gates", phase: "built" },
  { n: "1", name: "AI front desk", live: "Conversations on the record (WhatsApp through the inbox integration), lead and booking data model", proto: "Cross-channel inbox, AI drafts, qualification, booking into real slots, red lines, quiet-lead sequences, knowledge base and price table", phase: "phase 2 · weeks 2–6" },
  { n: "2", name: "Consultation preparation", live: "Medical history editor with dictation and note suggestions, the record the brief reads from", proto: "Intake links, the patient form, the one-page doctor brief with patient-reported flags, templates, consents on the tablet", phase: "phase 3 · weeks 5–10" },
  { n: "3", name: "Documentation copilot", live: "Dictation and ambient recording with consent, transcription (Arabic, English, mixed), structured extraction, review with medication reconciliation, sign into the record, a microphone in every free-text field", proto: "Documents per encounter with transcript evidence spans, sign and send", phase: "phase 3 · weeks 5–10" },
  { n: "4", name: "Photography", live: "Documents and files on the record", proto: "Stage-by-view timelines, quality flags, guided capture, side-by-side comparison, consent-gated exports", phase: "phase 4 · weeks 9–14" },
  { n: "5", name: "Post-treatment concierge", live: "The signed procedure the protocol engine listens to; outbound through the inbox integration", proto: "Versioned protocols, the board, structured check-ins with triage, the escalation ladder and roster", phase: "phase 4 · weeks 9–14" },
  { n: "6", name: "Management layer", live: "Overview with period comparisons; the grounded assistant with citations over the record", proto: "The CEO dashboard: thirteen metric definitions, six screens, weekly brief, alerts, natural-language questions, targets", phase: "phase 5 · weeks 12–16" },
  { n: "R", name: "AI rules", live: "Provider adapters per tenant (Gemini, OpenAI, Anthropic), AI run log with cost, red lines in the assistant prompt, refusal when the record does not answer", proto: "Kill switch, modes, red lines, prompt registry with evaluation gates, LLM call log, compliance card", phase: "phases 1–5" },
] as const;

export default async function ClinicAiPage() {
  const ctx = await getActingContext();
  const status = aiStatus();
  const tenant = ctx ? await db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { settings: true } }) : null;
  const tenantAi = publicAiConfig(aiConfigOf(tenant?.settings));
  const prototype = process.env.CLINIC_AI_PROTOTYPE_URL ?? "https://oudoo.github.io/ClinicMind/";
  const providerLine = (kind: "chat" | "transcription") => {
    const own = tenantAi[kind === "chat" ? "chatProvider" : "transcriptionProvider"];
    const global = status[kind];
    if (own && own !== "inherit") return `${own} (this clinic's own setting${tenantAi.keys?.[own as keyof typeof tenantAi.keys]?.set ? ", own key" : ""})`;
    return global.configured ? `${global.provider} · ${global.model}` : "not configured";
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Clinic AI"
        description="The Clinic AI Implementation Spec as a module on this record: what runs here today, what the click-through build shows, and the phase that brings the rest."
        action={<Badge tone="accent">module</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Walk the spec" description="Every module as a screen, with seeded data, in the click-through build. Sign in there as the Clinic AI lead." />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <a href={`${prototype}#/login`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent/90">
              Open the module walk-through
            </a>
            <span className="font-mono text-xs text-muted-foreground">ai@demo.clinic · the same password</span>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Front desk, consultation preparation, documentation copilot, photography, concierge, the CEO dashboard and the AI rules, each answering every click from seeded data. Nothing there leaves the browser.
          </p>
        </Card>
        <Card>
          <SectionTitle title="AI providers" description="What answers this clinic today." />
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-3"><dt className="data-label">chat</dt><dd className="text-right font-mono text-xs">{providerLine("chat")}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt className="data-label">transcription</dt><dd className="text-right font-mono text-xs">{providerLine("transcription")}</dd></div>
            <div className="flex items-baseline justify-between gap-3"><dt className="data-label">embeddings</dt><dd className="text-right font-mono text-xs">{status.embeddings.configured ? `${status.embeddings.provider} · ${status.embeddings.model}` : "offline"}</dd></div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Set per clinic by the platform administrator; keys are stored encrypted and never shown again. The assistant and the copilot answer only from this clinic&apos;s record.
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-6 py-4">
          <SectionTitle title="The six modules on this record" description="Live here today, shown in the walk-through, and the delivery phase from the roadmap." />
        </div>
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Module</TH>
              <TH>In this application today</TH>
              <TH className="hidden md:table-cell">In the walk-through</TH>
              <TH className="hidden lg:table-cell">Phase</TH>
            </TR>
          </THead>
          <TBody>
            {MODULES.map((m) => (
              <TR key={m.n}>
                <TD className="align-top">
                  <span className="font-medium">{m.n === "F" || m.n === "R" ? m.name : `${m.n} · ${m.name}`}</span>
                  <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground lg:hidden">{m.phase}</span>
                </TD>
                <TD className="align-top text-sm text-muted-foreground">{m.live}</TD>
                <TD className="hidden align-top text-sm text-muted-foreground md:table-cell">{m.proto}</TD>
                <TD className="hidden align-top lg:table-cell">
                  <Badge tone={m.phase === "built" ? "success" : "default"}>{m.phase}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <SectionTitle title="Live in this application now" description="The parts of the spec a clinician can use today, on the real backend." />
        <ul className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {[
            ["Dictation and ambient recording", "/dashboard/consultations", "Consultations → New consultation → Dictate; ambient mode asks for the patient's consent and logs it."],
            ["A microphone in every free-text field", "/dashboard/appointments", "Reason, notes, summary, address, the assistant's question: the transcript lands at the caret."],
            ["Transcript to signed record", "/dashboard/consultations", "Extract, review with medication reconciliation, sign; nothing reaches the record unsigned."],
            ["History from a dictated note", "/dashboard/patients", "Edit history → Dictate the history: suggested conditions, allergies, diagnoses and surgeries for review."],
            ["Grounded assistant", "/dashboard/assistant", "Answers only from this clinic's records, with citations, or an honest \"no matching records\". Clinicians only."],
            ["Evidence panel", "/dashboard/evidence", "Beside the consultation review: answers only from the clinic's approved library, each statement with its source, or \"no good source\". Clinicians only."],
            ["AI providers per clinic", "/platform", "Gemini, OpenAI or Anthropic per tenant with the client's own keys; every call logged with cost."],
          ].map(([title, href, text]) => (
            <li key={title} className="rounded-lg border border-border p-3">
              <Link href={href ?? "/dashboard"} className="font-medium hover:underline">
                {title}
              </Link>
              <p className="mt-0.5 text-xs text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
