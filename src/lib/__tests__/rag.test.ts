import { describe, expect, it } from "vitest";
import {
  buildCitations,
  computeConfidence,
  extractLexicalTerms,
  GROUNDED_THRESHOLD,
  rerank,
  type RetrievedChunk,
} from "@/lib/ai/rag";

function chunk(overrides: Partial<RetrievedChunk> & Pick<RetrievedChunk, "id" | "content" | "score">): RetrievedChunk {
  return {
    source: "DIAGNOSIS",
    refId: "ref",
    patientId: null,
    chunkIndex: 0,
    metadata: null,
    vectorScore: overrides.score,
    lexicalScore: 0,
    ...overrides,
  };
}

const chunks: RetrievedChunk[] = [
  chunk({ id: "1", source: "DIAGNOSIS", refId: "a", content: "Patient has essential hypertension", score: 0.6 }),
  chunk({ id: "2", source: "MEDICATION", refId: "b", content: "Prescribed amlodipine for blood pressure", score: 0.62 }),
  chunk({ id: "3", source: "VISIT_NOTE", refId: "c", content: "Routine asthma follow-up, inhaler refilled", score: 0.61 }),
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

describe("confidence", () => {
  it("is zero without retrieval", () => {
    expect(computeConfidence({ chunks: [], answer: "Anything [1]" })).toBe(0);
  });

  it("rises with the best match, the number of strong matches and citation use", () => {
    const weak = computeConfidence({ chunks: [{ score: 0.15 }], answer: "The records do not contain this." });
    const weakCited = computeConfidence({ chunks: [{ score: 0.15 }], answer: "Something [1]" });
    const strongUncited = computeConfidence({ chunks: [{ score: 0.8 }, { score: 0.5 }, { score: 0.45 }], answer: "No markers" });
    const strongCited = computeConfidence({ chunks: [{ score: 0.8 }, { score: 0.5 }, { score: 0.45 }], answer: "Fact [1], fact [3]" });
    expect(weak).toBeLessThan(GROUNDED_THRESHOLD);
    expect(weakCited).toBeLessThan(GROUNDED_THRESHOLD);
    expect(weakCited).toBeGreaterThan(weak);
    expect(strongUncited).toBeGreaterThan(weakCited);
    expect(strongCited).toBeGreaterThan(strongUncited);
    expect(strongCited).toBeGreaterThanOrEqual(GROUNDED_THRESHOLD);
    expect(strongCited).toBeLessThanOrEqual(1);
  });

  it("caps the strong-match contribution at three chunks", () => {
    const three = computeConfidence({ chunks: [0.7, 0.7, 0.7].map((score) => ({ score })), answer: "[1]" });
    const six = computeConfidence({ chunks: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7].map((score) => ({ score })), answer: "[1]" });
    expect(six).toBe(three);
  });

  it("is honest for an echo-style answer over a single lexical hit", () => {
    // One matching chunk, cited: grounded but not overstated.
    const c = computeConfidence({ chunks: [{ score: 0.5 }], answer: "Diagnoses: Essential hypertension [1]" });
    expect(c).toBeGreaterThanOrEqual(GROUNDED_THRESHOLD);
    expect(c).toBeLessThan(0.7);
  });
});

describe("lexical term extraction", () => {
  it("drops stopwords and generic clinic words, keeps names and drug names, longest first", () => {
    const terms = extractLexicalTerms("Which patients are taking Amlodipine for hypertension?");
    expect(terms).toEqual(["hypertension", "amlodipine"]);
  });

  it("strips possessives, de-duplicates and caps at six terms", () => {
    expect(extractLexicalTerms("Ahmed's allergies and Ahmed's surgeries")).toEqual(["allergies", "surgeries", "ahmed"]);
    const many = extractLexicalTerms("alpha bravo charlie delta echo foxtrot golf hotel india");
    expect(many).toHaveLength(6);
  });

  it("returns nothing for a query made only of stopwords", () => {
    expect(extractLexicalTerms("what is the")).toEqual([]);
  });

  it("handles Arabic text", () => {
    expect(extractLexicalTerms("هل يعاني أحمد من ضغط الدم")).toContain("يعاني");
  });
});

describe("citations", () => {
  const retrieved: RetrievedChunk[] = [
    chunk({
      id: "x1",
      source: "DIAGNOSIS",
      refId: "p1",
      patientId: "p1",
      content: "Patient: Ahmed Mahmoud. Diagnoses: Essential hypertension.",
      score: 0.6,
      metadata: { title: "Profile & medical history", occurredAt: null, kind: "patient_history", model: "echo-embed-1", patientName: "Ahmed Mahmoud" },
    }),
    chunk({ id: "x2", source: "CONVERSATION", refId: "conv1", patientId: null, content: "WhatsApp conversation about booking.", score: 0.4 }),
    chunk({
      id: "x3",
      source: "MEDICATION",
      refId: "p1",
      patientId: "p1",
      content: "Active medications: Amlodipine.",
      score: 0.3,
      metadata: { title: "Medications", occurredAt: null, kind: "patient_medications", model: "echo-embed-1", patientName: "Old Name" },
    }),
  ];
  const names = new Map([["p1", "Ahmed Mahmoud"]]);

  it("keeps only the items the answer cites, with their original indices and patient links", () => {
    const citations = buildCitations(retrieved, names, "Hypertension [1] on amlodipine [3].");
    expect(citations.map((c) => c.index)).toEqual([1, 3]);
    expect(citations[0]).toMatchObject({
      source: "DIAGNOSIS",
      refId: "p1",
      patientId: "p1",
      patientName: "Ahmed Mahmoud",
      title: "Profile & medical history",
      href: "/dashboard/patients/p1",
    });
    expect(citations[0]!.snippet).toContain("Essential hypertension");
    expect(citations[1]!.patientName).toBe("Ahmed Mahmoud"); // live name wins over stored metadata
  });

  it("lists every retrieved item when the answer carries no markers", () => {
    const citations = buildCitations(retrieved, names, "The records do not say.");
    expect(citations.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(citations[1]).toMatchObject({ patientId: null, patientName: null, href: null, title: "Conversation" });
  });
});
