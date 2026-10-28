import { describe, expect, it } from "vitest";
import {
  buildCitations,
  buildSystemPrompt,
  computeConfidence,
  extractLexicalTerms,
  GROUNDED_THRESHOLD,
  mentions,
  noMatchingRecordsAnswer,
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

  it("cites nothing when the answer carries no markers (retrieved records it did not use are not its sources)", () => {
    // Before the audit fix every retrieved record was listed under such an
    // answer, which made unrelated patients look like the answer's sources.
    expect(buildCitations(retrieved, names, "The records do not say.")).toEqual([]);
  });

  it("ignores markers that point outside the context", () => {
    const citations = buildCitations(retrieved, names, "Hypertension [1]; something else [9] and [0].");
    expect(citations.map((c) => c.index)).toEqual([1]);
  });

  it("cites every context patient the answer names, even without a marker", () => {
    const withSara: RetrievedChunk[] = [
      ...retrieved,
      chunk({
        id: "x4",
        source: "DIAGNOSIS",
        refId: "p2",
        patientId: "p2",
        content: "Patient: Sara Ibrahim. Allergies: Penicillin.",
        score: 0.5,
        metadata: { title: "Profile & medical history", occurredAt: null, kind: "patient_history", model: "echo-embed-1", patientName: "Sara Ibrahim" },
      }),
    ];
    const both = new Map([...names, ["p2", "Sara Ibrahim"]]);
    const citations = buildCitations(withSara, both, "Ahmed Mahmoud has hypertension [1]. Sara Ibrahim is allergic to penicillin.");
    expect(citations.map((c) => c.patientName)).toEqual(["Ahmed Mahmoud", "Sara Ibrahim"]);
    expect(citations.map((c) => c.index)).toEqual([1, 4]);
  });
});

describe("grounding rule in the prompt", () => {
  it("tells the model to name exactly the patients it cites and never to present retrieval as complete", () => {
    const prompt = buildSystemPrompt({ contextBlock: "[1] DIAGNOSIS · patient: Ahmed\nAllergies: Penicillin.", singlePatient: false, scope: "female · age over 40 (41 or older)", listQuestion: true });
    expect(prompt).toContain("The patients you name must be exactly the patients you cite");
    expect(prompt).toContain("never name a patient whose record does not show that they meet every one of them");
    expect(prompt).toContain("matches: female · age over 40 (41 or older)");
    expect(prompt).toContain("Never present a list of patients as complete");
    expect(prompt.endsWith("Allergies: Penicillin.")).toBe(true);
  });

  it("leaves the scope and list sentences out when they do not apply", () => {
    const prompt = buildSystemPrompt({ contextBlock: "", singlePatient: true, scope: null, listQuestion: false });
    expect(prompt).toContain("restricted to that patient's records");
    expect(prompt).not.toContain("Never present a list");
    expect(prompt).toContain("CONTEXT:\n(none)");
  });

  it("says a failed list search is not proof that nobody matches", () => {
    expect(noMatchingRecordsAnswer("Which patients are due their photos?")).toMatch(/no matching records/i);
    expect(noMatchingRecordsAnswer("Which patients are due their photos?", { listQuestion: true })).toMatch(/does not show that no patient matches/);
  });

  it("finds whole-name mentions only", () => {
    expect(mentions("Tarek Ezzat is on tranexamic acid [1].", "Tarek Ezzat")).toBe(true);
    expect(mentions("tarek  ezzat", "Tarek Ezzat")).toBe(true);
    expect(mentions("Tarek Ezzatson", "Tarek Ezzat")).toBe(false);
    expect(mentions("Hassan Ezzat", "Tarek Ezzat")).toBe(false);
  });
});
