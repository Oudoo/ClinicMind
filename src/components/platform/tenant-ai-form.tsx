"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import type { TenantAiPublic } from "@/lib/ai/tenant-config";

type Vendor = "gemini" | "openai" | "anthropic";
const VENDORS: { key: Vendor; label: string; placeholder: string }[] = [
  { key: "gemini", label: "Google Gemini key", placeholder: "AIza…" },
  { key: "openai", label: "OpenAI (ChatGPT) key", placeholder: "sk-…" },
  { key: "anthropic", label: "Anthropic (Claude) key", placeholder: "sk-ant-…" },
];
const MODELS: { key: keyof TenantAiPublic["models"]; label: string; placeholder: string }[] = [
  { key: "geminiChat", label: "Gemini chat model", placeholder: "gemini-2.5-flash" },
  { key: "openaiChat", label: "OpenAI chat model", placeholder: "gpt-4.1-mini" },
  { key: "anthropicChat", label: "Claude model", placeholder: "claude-opus-5-5" },
  { key: "geminiTranscription", label: "Gemini transcription model", placeholder: "gemini-2.5-flash" },
  { key: "openaiTranscription", label: "OpenAI transcription model", placeholder: "gpt-4o-transcribe" },
];

/**
 * Per-tenant AI configuration for the platform console. Keys are write-only:
 * the form shows whether one is set (with its last four characters), accepts a
 * replacement, or removes it. PATCH /api/tenants/[id] with `{ ai }`.
 */
export function TenantAiForm({ tenantId, initial }: { tenantId: string; initial: TenantAiPublic }) {
  const router = useRouter();
  const { toast } = useToast();
  const [chatProvider, setChatProvider] = useState(initial.chatProvider);
  const [transcriptionProvider, setTranscriptionProvider] = useState(initial.transcriptionProvider);
  const [models, setModels] = useState<Record<string, string>>(() => Object.fromEntries(MODELS.map((m) => [m.key, initial.models[m.key] ?? ""])));
  const [keys, setKeys] = useState<Record<Vendor, string>>({ gemini: "", openai: "", anthropic: "" });
  const [remove, setRemove] = useState<Record<Vendor, boolean>>({ gemini: false, openai: false, anthropic: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      const keyPatch: Partial<Record<Vendor, string>> = {};
      for (const v of VENDORS) {
        if (remove[v.key]) keyPatch[v.key] = "";
        else if (keys[v.key].trim()) keyPatch[v.key] = keys[v.key].trim();
      }
      const modelPatch: Record<string, string> = {};
      for (const m of MODELS) {
        const next = (models[m.key] ?? "").trim();
        const prev = initial.models[m.key] ?? "";
        if (next !== prev) modelPatch[m.key] = next;
      }
      await apiFetch(`/api/tenants/${tenantId}`, {
        method: "PATCH",
        body: {
          ai: {
            chatProvider,
            transcriptionProvider,
            ...(Object.keys(modelPatch).length ? { models: modelPatch } : {}),
            ...(Object.keys(keyPatch).length ? { keys: keyPatch } : {}),
          },
        },
      });
      toast({ title: "AI providers saved", description: "Applies to the clinic's next AI call.", tone: "success" });
      setKeys({ gemini: "", openai: "", anthropic: "" });
      setRemove({ gemini: false, openai: false, anthropic: false });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const fe = fieldErrors(err);
        setIssues(fe);
        setError(Object.keys(fe).length ? "Check the highlighted fields." : err.message);
      } else setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Chat, extraction and assistant" htmlFor="ai-chat" hint="inherit = the platform's default order (Gemini → OpenAI → Claude)">
          <Select id="ai-chat" value={chatProvider} onChange={(e) => setChatProvider(e.target.value as TenantAiPublic["chatProvider"])}>
            <option value="inherit">Inherit platform default</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI (ChatGPT)</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </Select>
        </Field>
        <Field label="Dictation and transcription" htmlFor="ai-stt" hint="Claude takes no audio; speech-to-text runs on Gemini or OpenAI">
          <Select id="ai-stt" value={transcriptionProvider} onChange={(e) => setTranscriptionProvider(e.target.value as TenantAiPublic["transcriptionProvider"])}>
            <option value="inherit">Inherit platform default</option>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
          </Select>
        </Field>
      </div>

      <div className="space-y-3 rounded-lg border border-border p-3">
        <p className="data-label">Client keys (optional)</p>
        <p className="text-xs text-muted-foreground">Leave blank to keep the platform's key. A clinic's own key is encrypted at rest and used only for its own calls.</p>
        {VENDORS.map((v) => (
          <div key={v.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field
              label={v.label}
              htmlFor={`ai-key-${v.key}`}
              hint={
                issues[`keys.${v.key}`] ??
                (initial.keys[v.key].set ? (
                  <span className="flex items-center gap-2">
                    <Badge tone="success">key set</Badge>
                    <span className="font-mono">{initial.keys[v.key].hint}</span>
                  </span>
                ) : (
                  "no client key; the platform's key is used"
                ))
              }
            >
              <Input
                id={`ai-key-${v.key}`}
                type="password"
                autoComplete="off"
                value={keys[v.key]}
                onChange={(e) => setKeys((k) => ({ ...k, [v.key]: e.target.value }))}
                placeholder={initial.keys[v.key].set ? "enter a new key to replace" : v.placeholder}
                disabled={remove[v.key]}
              />
            </Field>
            {initial.keys[v.key].set ? (
              <label className="flex items-center gap-2 pb-6 text-xs text-muted-foreground">
                <Checkbox checked={remove[v.key]} onChange={(e) => setRemove((r) => ({ ...r, [v.key]: e.target.checked }))} />
                remove
              </label>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>

      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Model overrides</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {MODELS.map((m) => (
            <Field key={m.key} label={m.label} htmlFor={`ai-model-${m.key}`} hint={issues[`models.${m.key}`]}>
              <Input
                id={`ai-model-${m.key}`}
                value={models[m.key] ?? ""}
                onChange={(e) => setModels((cur) => ({ ...cur, [m.key]: e.target.value }))}
                placeholder={m.placeholder}
                className="font-mono text-xs"
              />
            </Field>
          ))}
        </div>
      </details>

      <Button type="submit" size="sm" disabled={busy}>
        <Save className="h-4 w-4" /> {busy ? "Saving…" : "Save AI providers"}
      </Button>
    </form>
  );
}
