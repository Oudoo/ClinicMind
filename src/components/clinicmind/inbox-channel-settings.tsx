"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Copy, KeyRound, Send, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import { DELIVERY_LABELS, type DeliveryKey, type IntegrationStatusDTO } from "@/modules/messaging/dto";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { crmErrorMessage } from "./lead-shared";

type Provider = IntegrationStatusDTO["provider"];

const PROVIDERS: { value: Provider; title: string; text: string }[] = [
  { value: "manual", title: "Manual", text: "Replies are logged on the record only; send them from the clinic phone (wa.me)." },
  { value: "whatsapp_cloud", title: "WhatsApp Cloud API", text: "Meta's API sends from the clinic's WhatsApp Business number." },
  { value: "inbox_webhook", title: "Inbox webhook", text: "Each reply is POSTed, signed, to the clinic's own inbox system." },
];

async function copy(text: string, toast: ReturnType<typeof useToast>["toast"], what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: `${what} copied`, tone: "success" });
  } catch {
    toast({ title: "Copy failed: select the text and copy it", tone: "danger" });
  }
}

function EnvFlag({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <li className="flex items-start gap-2 text-xs">
      {ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />}
      <span>
        <span className="font-mono">{label}</span> {ok ? "is set on the server." : "is not set on the server"}
        {ok ? null : <span className="text-muted-foreground"> — {hint}</span>}
      </span>
    </li>
  );
}

/**
 * The owner's controls for the messaging connection: the provider and its
 * settings, the inbound webhook URL and its secret (shown once), and a test
 * message to a chosen patient with the delivery result.
 */
export function InboxChannelSettings({ status }: { status: IntegrationStatusDTO }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [provider, setProvider] = useState<Provider>(status.provider);
  const [phoneNumberId, setPhoneNumberId] = useState(status.phoneNumberId ?? "");
  const [outboundUrl, setOutboundUrl] = useState(status.outboundUrl ?? "");
  const [enabled, setEnabled] = useState(status.provider === "manual" ? true : status.enabled);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [testBody, setTestBody] = useState("");
  const [result, setResult] = useState<{ delivery: DeliveryKey; failedReason: string | null } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await apiFetch("/api/messaging/integration", {
        method: "PATCH",
        body: { provider, phoneNumberId, outboundUrl, ...(provider === "manual" ? {} : { enabled }) },
      });
      toast({ title: "Connection saved", tone: "success" });
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const res = await apiFetch<{ secret: string; prefix: string }>("/api/messaging/integration/secret", { method: "POST" });
      setSecret(res.secret);
      setConfirmRotate(false);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not generate the secret", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(e: FormEvent) {
    e.preventDefault();
    if (busy || !patient) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await apiFetch<{ delivery: DeliveryKey; failedReason: string | null }>("/api/messaging/integration/test", { method: "POST", body: { patientId: patient.id, body: testBody } });
      setResult(res);
      router.refresh();
    } catch (err) {
      toast({ title: "The test could not be sent", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <form onSubmit={save} className="space-y-4 rounded-lg border border-border p-4" aria-label="Messaging connection" noValidate>
        <p className="text-sm font-medium">Connection</p>
        {error ? <Alert>{error}</Alert> : null}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3" role="radiogroup" aria-label="Provider">
          {PROVIDERS.map((p) => (
            <label key={p.value} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition-colors", provider === p.value ? "border-accent bg-accent-muted/60" : "border-border hover:bg-muted")}>
              <input type="radio" name={`${id}-provider`} value={p.value} checked={provider === p.value} onChange={() => setProvider(p.value)} className="mt-1 h-4 w-4 accent-[hsl(var(--accent))]" />
              <span>
                <span className="block font-medium">{p.title}</span>
                <span className="block text-xs text-muted-foreground">{p.text}</span>
              </span>
            </label>
          ))}
        </div>
        {provider === "whatsapp_cloud" ? (
          <div className="space-y-3">
            <Field label="Phone number id" htmlFor={`${id}-pnid`} hint={issues.phoneNumberId ? <span className="text-danger">{issues.phoneNumberId}</span> : "WhatsApp Manager → API setup → Phone number ID (digits)"}>
              <Input id={`${id}-pnid`} inputMode="numeric" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} className="font-mono sm:max-w-xs" />
            </Field>
            <ul className="space-y-1">
              <EnvFlag ok={status.env.whatsappTokenSet} label="WHATSAPP_CLOUD_TOKEN" hint="replies will fail (and say so) until the server has the access token." />
              <EnvFlag ok={status.env.whatsappAppSecretSet} label="WHATSAPP_APP_SECRET" hint="Meta's signed deliveries to the inbound URL are refused without it." />
              <EnvFlag ok={status.env.whatsappVerifyTokenSet} label="WHATSAPP_VERIFY_TOKEN" hint="needed once, when Meta verifies the inbound URL." />
            </ul>
          </div>
        ) : null}
        {provider === "inbox_webhook" ? (
          <Field label="Outbound URL" htmlFor={`${id}-url`} hint={issues.outboundUrl ? <span className="text-danger">{issues.outboundUrl}</span> : "Each reply is POSTed here as JSON, signed with the webhook secret (X-ClinicMind-Signature)."}>
            <Input id={`${id}-url`} type="url" value={outboundUrl} onChange={(e) => setOutboundUrl(e.target.value)} placeholder="https://inbox.example.com/clinicmind" className="font-mono" />
          </Field>
        ) : null}
        {provider !== "manual" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Send replies through it (off: replies are logged only)
          </label>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy}>
            Save connection
          </Button>
        </div>
      </form>

      <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Inbound webhook">
        <p className="text-sm font-medium">Inbound webhook</p>
        <p className="text-xs text-muted-foreground">
          Patients' messages arrive here. The clinic's inbox signs each POST with the secret (HMAC-SHA256 of the raw body, hex, in <span className="font-mono">X-ClinicMind-Signature</span>); WhatsApp Cloud signs with Meta's app secret.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs" title={status.inboundUrl}>
            {status.inboundUrl}
          </code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy(status.inboundUrl, toast, "Inbound URL")}>
            <Copy className="h-4 w-4" />
            Copy
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">
            Secret: {status.hasSecret ? <span className="font-mono text-xs">{status.secretPrefix}…</span> : <Badge tone="warning">not generated</Badge>}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => (status.hasSecret ? setConfirmRotate(true) : void rotate())}>
            <KeyRound className="h-4 w-4" />
            {status.hasSecret ? "Rotate secret" : "Generate secret"}
          </Button>
        </div>
        {secret ? (
          <Alert tone="success" className="space-y-2">
            <p className="font-medium">Copy the secret now: it is shown only this once.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-card px-2 py-1 font-mono text-xs text-foreground">{secret}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(secret, toast, "Secret")}>
                <Copy className="h-4 w-4" />
                Copy
              </Button>
            </div>
          </Alert>
        ) : null}
      </section>

      <form onSubmit={sendTest} className="space-y-3 rounded-lg border border-border p-4" aria-label="Test message">
        <p className="text-sm font-medium">Send a test message</p>
        <PatientPicker value={patient} onChange={setPatient} />
        <Field label="Text" htmlFor={`${id}-test`} hint="Optional; a short “please ignore” note by default.">
          <DictationField multiline={false} onDictated={setTestBody} disabled={busy}>
            <Input id={`${id}-test`} value={testBody} onChange={(e) => setTestBody(e.target.value)} maxLength={1000} />
          </DictationField>
        </Field>
        {result ? (
          <Alert tone={result.delivery === "FAILED" ? "danger" : result.delivery === "LOGGED" ? "info" : "success"}>
            {result.delivery === "FAILED" ? `Not delivered: ${result.failedReason ?? "the provider refused it"}` : DELIVERY_LABELS[result.delivery]}
            {result.delivery === "LOGGED" ? " — it is on the patient's conversation in the inbox." : null}
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={busy || !patient}>
            <Send className="h-4 w-4" />
            Send test
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the webhook secret?"
        description="The old secret stops working at once: the clinic's inbox must sign with the new one."
        confirmLabel="Rotate secret"
        tone="danger"
        busy={busy}
        onConfirm={rotate}
      />
    </div>
  );
}
