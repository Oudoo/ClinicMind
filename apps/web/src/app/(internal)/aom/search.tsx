"use client";

import { useState, useTransition } from "react";
import { searchAom } from "@/app/actions/intelligence";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Result = {
  entityType: string;
  entityId: string;
  clientId: string | null;
  chunkText: string;
  similarity: number;
};

export function AomSearch({ clients }: { clients: { id: string; name: string }[] }) {
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await searchAom(query, clientId || undefined);
      setResults(res.results as Result[]);
      setError(res.error ?? null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Semantic search</CardTitle>
        <CardDescription>
          pgvector-backed. Try: &ldquo;every discussion about TikTok&rdquo; or &ldquo;conversations
          mentioning pricing concerns&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSearch} className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the agency's memory…"
            className="flex-1"
          />
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-48">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Button type="submit" disabled={pending || query.length < 3}>
            {pending ? "Searching…" : "Search"}
          </Button>
        </form>
        {error && (
          <p className="mt-2 text-sm text-amber-600">
            {error.includes("OPENAI") ? "Semantic search needs an embedding provider (OPENAI_API_KEY)." : error}
          </p>
        )}
        {results && (
          <div className="mt-3 space-y-2">
            {results.map((r, i) => (
              <div key={i} className="rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline">{r.entityType.replace(/_/g, " ")}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {(r.similarity * 100).toFixed(0)}% match
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-muted-foreground">{r.chunkText.slice(0, 350)}…</p>
              </div>
            ))}
            {results.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">No matches found.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
