import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { aiStatus } from "@/lib/ai/provider";
import { aiConfigOf, publicAiConfig } from "@/lib/ai/tenant-config";
import { Card, SectionTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

/** Where each AI feature of the application is, and the AI providers that answer this clinic. */
const FEATURES = [
  ["Dictation and ambient recording", "/dashboard/consultations", "Consultations → New consultation → Dictate; ambient mode asks for the patient's consent and logs it."],
  ["A microphone in every free-text field", "/dashboard/appointments", "Reason, notes, summary, address, the assistant's question: the transcript lands at the caret."],
  ["Transcript to signed record", "/dashboard/consultations", "Extract, review with medication reconciliation, sign; nothing reaches the record unsigned."],
  ["History from a dictated note", "/dashboard/patients", "Edit history → Dictate the history: suggested conditions, allergies, diagnoses and surgeries for review."],
  ["Grounded assistant", "/dashboard/assistant", "Answers only from this clinic's records, with citations, or an honest \"no matching records\". Clinicians only."],
  ["Evidence panel", "/dashboard/evidence", "Beside the consultation review: answers only from the clinic's approved library, each statement with its source, or \"no good source\". Clinicians only."],
  ["Monthly AI review", "/dashboard/evidence/review", "Every question with its answer and citations, the doctors' ratings and the prescribing overrides, month by month. The owner with the clinician mark."],
  ["AI providers per clinic", "/platform", "Gemini, OpenAI or Anthropic per tenant with the client's own keys; every call logged with cost."],
] as const;

export default async function ClinicAiPage() {
  const ctx = await getActingContext();
  const status = aiStatus();
  const tenant = ctx ? await db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { settings: true } }) : null;
  const tenantAi = publicAiConfig(aiConfigOf(tenant?.settings));
  const providerLine = (kind: "chat" | "transcription") => {
    const own = tenantAi[kind === "chat" ? "chatProvider" : "transcriptionProvider"];
    const global = status[kind];
    if (own && own !== "inherit") return `${own} (this clinic's own setting${tenantAi.keys?.[own as keyof typeof tenantAi.keys]?.set ? ", own key" : ""})`;
    return global.configured ? `${global.provider} · ${global.model}` : "not configured";
  };

  return (
    <div className="space-y-6">
      <SectionTitle title="Clinic AI" description="What the AI does in this clinic, where to find it, and the providers that answer." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="The AI features" description="Every one answers only from this clinic's records or library; nothing reaches the record until a clinician signs." />
          <ul className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            {FEATURES.map(([title, href, text]) => (
              <li key={title} className="rounded-lg border border-border p-3">
                <Link href={href} className="font-medium hover:underline">
                  {title}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">{text}</p>
              </li>
            ))}
          </ul>
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
    </div>
  );
}
