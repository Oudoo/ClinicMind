"use client";

import { useId, useState } from "react";
import { Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { FEEDBACK_COMMENT_MAX } from "@/modules/ai-log/constants";

/**
 * "Was this useful?" under an AI answer: the doctor who asked rates it, and
 * says what was wrong when it was not. Every rating is kept; the owner reads
 * them in the monthly review.
 */
export function AnswerRating({ runId }: { runId: string | null | undefined }) {
  const id = useId();
  const [explaining, setExplaining] = useState(false);
  const [sending, setSending] = useState(false);
  const [rated, setRated] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!runId) return null;

  async function send(helpful: boolean) {
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/api/ai-runs/${runId}/feedback`, { method: "POST", body: { helpful, ...(!helpful && comment.trim() ? { comment: comment.trim() } : {}) } });
      setRated(helpful);
      setExplaining(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The rating could not be saved.");
    } finally {
      setSending(false);
    }
  }

  if (rated !== null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="answer-rated">
        {rated ? "Marked as useful." : "Marked as not useful."} The owner sees the ratings in the monthly review.{" "}
        <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => setRated(null)}>
          Change
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="answer-rating">
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <span className="mr-1">Was this useful?</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => void send(true)} disabled={sending} aria-label="Useful">
          <ThumbsUp className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button type="button" size="sm" variant={explaining ? "outline" : "ghost"} onClick={() => setExplaining(true)} disabled={sending} aria-label="Not useful">
          <ThumbsDown className="h-4 w-4" aria-hidden="true" />
        </Button>
        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      </div>
      {explaining ? (
        <div className="space-y-2">
          <label htmlFor={`${id}-comment`} className="data-label block">
            What was wrong? (optional)
          </label>
          <Textarea
            id={`${id}-comment`}
            rows={2}
            dir="auto"
            maxLength={FEEDBACK_COMMENT_MAX}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="min-h-[3.5rem]"
            disabled={sending}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setExplaining(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void send(false)} disabled={sending}>
              Send
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
