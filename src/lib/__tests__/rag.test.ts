import { describe, it, expect } from "vitest";
import { rerank, type RetrievedChunk } from "@/lib/ai/rag";

const chunks: RetrievedChunk[] = [
  { id: "1", source: "DIAGNOSIS", refId: "a", content: "Patient has essential hypertension", score: 0.6 },
  { id: "2", source: "MEDICATION", refId: "b", content: "Prescribed amlodipine for blood pressure", score: 0.62 },
  { id: "3", source: "VISIT_NOTE", refId: "c", content: "Routine asthma follow-up, inhaler refilled", score: 0.61 },
];

describe("RAG re-ranking", () => {
  it("boosts chunks that lexically overlap the query above raw vector score", () => {
    const ranked = rerank("hypertension blood pressure", chunks);
    expect(ranked[0]?.id).toBe("2"); // strongest lexical + vector overlap
    expect(ranked.map((c) => c.id)).not.toContain(undefined);
  });

  it("is stable and returns all chunks", () => {
    const ranked = rerank("asthma", chunks);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.id).toBe("3");
  });
});
