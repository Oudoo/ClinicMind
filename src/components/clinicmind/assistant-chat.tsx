"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";

interface Citation {
  index: number;
  source: string;
  refId: string;
  snippet: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  confidence?: number;
  provider?: string;
}

const SUGGESTIONS = [
  "Show me patients who missed follow-ups",
  "Summarize today's appointments",
  "Find high-risk diabetic patients",
  "Compare hypertension progress across patients",
];

export function AssistantChat() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, loading]);

  async function send(message: string) {
    const text = message.trim();
    if (!text || loading) return;
    setTurns((t) => [...t, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      });
      const data = await res.json();
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: data.answer ?? data.error ?? "No response.",
          citations: data.citations ?? [],
          confidence: data.confidence,
          provider: data.provider,
        },
      ]);
    } catch {
      setTurns((t) => [...t, { role: "assistant", content: "Request failed. Try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col bento p-0">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-6">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-flow text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold">Doctor AI Assistant</h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Ask in natural language. Every answer is grounded in your clinic's records via
                retrieval (RAG) and shows citations — never an ungrounded guess.
              </p>
            </div>
            <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-md border border-border bg-card px-3 py-2 text-left text-sm hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                  turn.role === "user"
                    ? "bg-accent text-accent-foreground"
                    : "border border-border bg-card"
                }`}
              >
                <p className="whitespace-pre-wrap">{turn.content}</p>
                {turn.citations && turn.citations.length > 0 ? (
                  <div className="mt-3 space-y-1.5 border-t border-border/60 pt-3">
                    {turn.citations.map((c) => (
                      <div key={c.index} className="flex gap-2 text-xs text-muted-foreground">
                        <Quote className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                        <span>
                          <span className="font-mono text-accent">[{c.index}]</span>{" "}
                          <span className="font-mono uppercase">{c.source}</span> — {c.snippet}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {turn.role === "assistant" && turn.provider ? (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge>{turn.provider}</Badge>
                    {typeof turn.confidence === "number" ? (
                      <Badge tone={turn.confidence > 0.6 ? "success" : "warning"}>
                        {Math.round(turn.confidence * 100)}% conf
                      </Badge>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
        {loading ? (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <span className="data-label animate-pulse-spike">retrieving + reasoning…</span>
            </div>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-border p-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about patients, appointments, trends…"
          className="h-10 flex-1 rounded-lg border border-input bg-background px-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Button type="submit" size="icon" disabled={loading || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
