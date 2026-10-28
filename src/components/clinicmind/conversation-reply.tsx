"use client";

import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { waMeLink } from "@/modules/crm/shared";
import { DELIVERY_MODE_LABELS, WHATSAPP_WINDOW_HOURS, type ConversationThreadDTO, type DeliveryKey, type TemplateDTO } from "@/modules/messaging/dto";
import { renderTemplate, unfilledPlaceholders } from "@/modules/messaging/placeholders";
import { crmErrorMessage } from "./lead-shared";

const CATEGORY_LABELS: Record<string, string> = { booking: "Booking", price: "Price", "follow-up": "Follow-up", intake: "Intake", concierge: "Concierge" };

/**
 * The reply box: a template picker that fills {{name}}, {{clinic}},
 * {{doctor}}, {{date}} and {{link}} from the thread, the text (with the
 * microphone), and Send. With no channel connected the reply is logged on
 * the record, and "Send from WhatsApp" also opens a click-to-WhatsApp link
 * (wa.me) with the text ready on the clinic's phone.
 */
export function ConversationReply({ conversation, templates, now }: { conversation: ConversationThreadDTO; templates: TemplateDTO[]; now: Date }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unfilled = unfilledPlaceholders(body);
  const wa = conversation.channel === "WHATSAPP" ? waMeLink(conversation.contactPhone) : null;
  const logged = conversation.deliveryMode === "logged";
  const windowClosed =
    conversation.deliveryMode === "whatsapp_cloud" &&
    conversation.channel === "WHATSAPP" &&
    (!conversation.lastInboundAt || now.getTime() - new Date(conversation.lastInboundAt).getTime() > WHATSAPP_WINDOW_HOURS * 3_600_000);

  // The thread's language first, then the rest, grouped by category.
  const groups = useMemo(() => {
    const sorted = [...templates].sort((a, b) => Number(b.language === conversation.locale) - Number(a.language === conversation.locale));
    const map = new Map<string, TemplateDTO[]>();
    for (const t of sorted) map.set(t.category ?? "other", [...(map.get(t.category ?? "other") ?? []), t]);
    return [...map.entries()];
  }, [templates, conversation.locale]);

  function insert(key: string) {
    const template = templates.find((t) => t.key === key);
    if (!template) return;
    const filled = renderTemplate(template.body, conversation.templateContext);
    setBody((current) => (current.trim() ? `${current.trimEnd()}\n${filled}` : filled));
    setTemplateKey(template.key);
    setError(null);
  }

  async function send(fromPhone: boolean) {
    if (busy || !body.trim() || unfilled.length) return;
    // Open the chat first (a popup must come straight from the click), then keep the record.
    if (fromPhone && wa) window.open(`${wa}?text=${encodeURIComponent(body)}`, "_blank", "noopener,noreferrer");
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ delivery: DeliveryKey; failedReason: string | null }>(`/api/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: templateKey ? { body, templateKey } : { body },
      });
      if (res.delivery === "FAILED") {
        toast({ title: "Saved, but not delivered", description: res.failedReason ?? "The channel refused the message.", tone: "danger", durationMs: 7000 });
      } else if (res.delivery === "LOGGED") {
        toast({ title: fromPhone ? "Opened in WhatsApp and logged on the record" : "Reply logged on the record", description: fromPhone ? undefined : "No channel is connected, so nothing left the clinic.", tone: "info" });
      } else {
        toast({ title: "Reply sent", tone: "success" });
      }
      setBody("");
      setTemplateKey(null);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setError(fields.body ?? crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-border bg-card p-3" aria-label="Reply">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Insert a reply template" value="" onChange={(e) => insert(e.target.value)} className="h-8 w-full text-xs sm:w-64" disabled={!templates.length}>
          <option value="">{templates.length ? "Insert a template…" : "No templates yet"}</option>
          {groups.map(([category, items]) => (
            <optgroup key={category} label={CATEGORY_LABELS[category] ?? category}>
              {items.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground">{DELIVERY_MODE_LABELS[conversation.deliveryMode]}</span>
      </div>
      <label htmlFor={`${id}-body`} className="sr-only">
        Reply
      </label>
      <DictationField onDictated={setBody} disabled={busy}>
        <Textarea
          id={`${id}-body`}
          dir="auto"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (!e.target.value.trim()) setTemplateKey(null);
          }}
          onKeyDown={onKeyDown}
          maxLength={4000}
          placeholder="Write a reply… (Ctrl+Enter sends)"
          className="min-h-[4.5rem]"
        />
      </DictationField>
      {unfilled.length ? (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          Replace {unfilled.map((p) => `{{${p}}}`).join(", ")} before sending.
        </p>
      ) : null}
      {windowClosed ? (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          More than {WHATSAPP_WINDOW_HOURS} h since the patient last wrote: WhatsApp may refuse a free-form reply until they write again.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {logged && wa ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void send(true)} disabled={busy || !body.trim() || unfilled.length > 0} title="Open WhatsApp with this text on the clinic's phone and keep it on the record">
            <MessageCircle className="h-4 w-4 text-success" />
            Send from WhatsApp
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={busy || !body.trim() || unfilled.length > 0}>
          <Send className="h-4 w-4" />
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
