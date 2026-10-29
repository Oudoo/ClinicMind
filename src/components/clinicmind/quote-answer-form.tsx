"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { ApiError, apiFetch } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { QUOTE_COPY } from "@/modules/quotes/copy";
import type { PublicQuoteDTO } from "@/modules/quotes/dto";
import { SignaturePad } from "./signature-pad";

type Mode = { kind: "link"; token: string } | { kind: "clinic"; quoteId: string };

/**
 * The patient's answer to a treatment plan, in the plan's language: the
 * treatments they accept (all ticked to start with), their name typed, their
 * signature and the box that says what they agree to, with the total of what
 * is ticked. Behind the link (`mode.kind === "link"`) they can also decline,
 * saying why if they want; on the clinic's screen the patient signs and the
 * staff member who hands over the screen records it.
 */
export function QuoteAnswerForm({ quote, mode, onDone }: { quote: PublicQuoteDTO; mode: Mode; onDone?: () => void }) {
  const t = QUOTE_COPY[quote.language];
  const id = useId();
  const router = useRouter();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(quote.items.map((i) => i.id)));
  const [name, setName] = useState("");
  const [signature, setSignature] = useState("");
  const [agree, setAgree] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<null | "accepted" | "declined">(null);
  const total = useMemo(() => quote.items.filter((i) => chosen.has(i.id)).reduce((s, i) => s + i.net, 0), [chosen, quote.items]);

  function toggle(itemId: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  function explain(err: unknown): string {
    if (err instanceof ApiError) {
      // On the clinic's screen, the server's own words (prices changed, expired…).
      const message = (err.body as { message?: unknown } | null)?.message;
      if (mode.kind === "clinic" && typeof message === "string" && message) return message;
      if (err.status === 409 || err.status === 404) return t.errors.closed;
      if (err.status === 429) return t.errors.tooMany;
    }
    return t.errors.generic;
  }

  async function accept(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!chosen.size) next.items = t.errors.items;
    if (name.trim().length < 2) next.name = t.errors.name;
    if (!signature) next.signature = t.errors.signature;
    if (!agree) next.agree = t.errors.agree;
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    const body = { itemIds: [...chosen], name: name.trim(), signature, agree: true };
    try {
      if (mode.kind === "link") await apiFetch(`/api/public/quotes/${mode.token}`, { method: "POST", body: { action: "accept", ...body } });
      else await apiFetch(`/api/quotes/${mode.quoteId}/accept`, { method: "POST", body });
      setDone("accepted");
      onDone?.();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const issues = ((err.body as { issues?: { fieldErrors?: Record<string, string[]> } })?.issues?.fieldErrors ?? {}) as Record<string, string[]>;
        setErrors({
          ...(issues.itemIds ? { items: t.errors.items } : {}),
          ...(issues.name ? { name: t.errors.name } : {}),
          ...(issues.signature ? { signature: t.errors.signature } : {}),
          ...(issues.agree ? { agree: t.errors.agree } : {}),
        });
        if (!Object.keys(issues).length) setFailure(t.errors.generic);
      } else setFailure(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (busy || mode.kind !== "link") return;
    setBusy(true);
    setFailure(null);
    try {
      await apiFetch(`/api/public/quotes/${mode.token}`, { method: "POST", body: { action: "decline", ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      setDone("declined");
      router.refresh();
    } catch (err) {
      setFailure(explain(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const copy = t.done[done];
    return (
      <section dir={t.dir} lang={quote.language} className="bento space-y-1 text-center" role="status" data-testid="quote-answered">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden="true" />
        <h2 className="font-display text-lg font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </section>
    );
  }

  return (
    <form dir={t.dir} lang={quote.language} onSubmit={accept} className="space-y-5" noValidate aria-label={t.form.title} data-testid="quote-answer-form">
      {mode.kind === "link" ? (
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">{t.form.title}</h2>
          <p className="text-sm text-muted-foreground">{t.form.intro}</p>
        </div>
      ) : null}

      <fieldset className="space-y-3" aria-describedby={`${id}-choose-hint`} aria-invalid={errors.items ? true : undefined}>
        <legend className="data-label">{t.form.choose}</legend>
        <p id={`${id}-choose-hint`} className="text-xs text-muted-foreground">
          {t.form.chooseHint}
        </p>
        {quote.phases.map((title, p) => {
          const items = quote.items.filter((i) => i.phase === p);
          if (!items.length) return null;
          return (
            <div key={p} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t.phase(p + 1)} · <bdi>{title}</bdi>
              </p>
              {items.map((i) => (
                <label key={i.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/40">
                  <Checkbox className="mt-0.5" checked={chosen.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm" dir="auto">
                      {i.description}
                    </span>
                    {i.site ? <span className="block text-xs text-muted-foreground">{i.site}</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums" dir="ltr">
                    {formatNumber(i.net)}
                  </span>
                </label>
              ))}
            </div>
          );
        })}
        {errors.items ? <p className="text-xs text-danger">{errors.items}</p> : null}
      </fieldset>

      <p className="flex items-baseline justify-between gap-4 border-t border-border pt-2 font-semibold">
        <span>{t.total}</span>
        <span className="font-mono tabular-nums" dir="ltr" data-testid="quote-chosen-total">
          {formatNumber(total)}
        </span>
      </p>

      <div className="space-y-1.5">
        <label htmlFor={`${id}-name`} className="data-label block">
          {t.form.name}
        </label>
        <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} aria-invalid={errors.name ? true : undefined} />
        {errors.name ? <p className="text-xs text-danger">{errors.name}</p> : null}
      </div>

      <div className="space-y-1">
        <SignaturePad id={`${id}-signature`} label={t.form.sign} hint={t.form.signHint} clearLabel={t.form.clear} invalid={Boolean(errors.signature)} onChange={setSignature} />
        {errors.signature ? <p className="text-xs text-danger">{errors.signature}</p> : null}
      </div>

      <div className="space-y-1">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-invalid={errors.agree ? true : undefined} />
          <span>{t.form.agree(formatNumber(total))}</span>
        </label>
        {errors.agree ? <p className="text-xs text-danger">{errors.agree}</p> : null}
      </div>

      {failure ? <Alert>{failure}</Alert> : null}

      <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
        <PenLine className="h-4 w-4" aria-hidden="true" />
        {busy ? t.form.sending : t.form.accept}
      </Button>

      {mode.kind === "link" ? (
        <div className="border-t border-border pt-4">
          {declining ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t.form.declineTitle}</p>
              <label htmlFor={`${id}-reason`} className="data-label block">
                {t.form.declineReason}
              </label>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="min-h-[4rem]" />
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => void decline()}>
                  {t.form.decline}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setDeclining(false)}>
                  {t.form.back}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDeclining(true)}>
              {t.form.declineOpen}
            </Button>
          )}
        </div>
      ) : null}
    </form>
  );
}
