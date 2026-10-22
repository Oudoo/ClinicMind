import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chunkText, contentHash, normalizeText } from "@/modules/knowledge/chunking";

const sentence = (i: number) => `Sentence number ${i} describes a finding in the patient's record.`;

function paragraphs(count: number, sentencesEach: number): string {
  const out: string[] = [];
  let n = 0;
  for (let p = 0; p < count; p++) {
    const s: string[] = [];
    for (let i = 0; i < sentencesEach; i++) s.push(sentence(++n));
    out.push(s.join(" "));
  }
  return out.join("\n\n");
}

describe("contentHash", () => {
  it("is the SHA-256 hex digest of the content", () => {
    expect(contentHash("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("normalizeText", () => {
  it("normalises line endings, trailing spaces and runs of blank lines", () => {
    expect(normalizeText("a  \r\nb\r\n\r\n\r\n\r\nc\n")).toBe("a\nb\n\nc");
  });
});

describe("chunkText", () => {
  it("returns nothing for blank input and one chunk for short input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
    const [only, ...rest] = chunkText("Short note.");
    expect(rest).toHaveLength(0);
    expect(only).toEqual({ index: 0, content: "Short note.", hash: contentHash("Short note.") });
  });

  it("respects the size limit and prefers paragraph boundaries", () => {
    const text = paragraphs(12, 4);
    const chunks = chunkText(text, { size: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(800);
      // Every chunk ends at a sentence/paragraph boundary and starts on a word boundary, never mid-word.
      expect(c.content).toMatch(/\.$/);
      const firstWord = c.content.split(/\s/)[0]!;
      expect(new RegExp(`(^|\\s)${firstWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)).toBe(true);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("overlaps consecutive chunks by roughly the configured amount, on a word boundary", () => {
    const text = paragraphs(10, 5);
    const chunks = chunkText(text, { size: 800, overlap: 100 });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.content;
      const head = chunks[i]!.content.slice(0, 40);
      expect(prev).toContain(head); // the next chunk starts inside the previous one
      const tailOfPrev = prev.slice(prev.lastIndexOf(head));
      expect(tailOfPrev.length).toBeLessThanOrEqual(100 + 40);
    }
  });

  it("covers the whole document: every sentence appears in at least one chunk", () => {
    const text = paragraphs(15, 3);
    const chunks = chunkText(text);
    const joined = chunks.map((c) => c.content).join("\n");
    for (let i = 1; i <= 45; i++) expect(joined).toContain(sentence(i));
  });

  it("is deterministic and localises hash changes to the edited region", () => {
    const text = paragraphs(10, 4);
    const a = chunkText(text);
    const b = chunkText(text);
    expect(a).toEqual(b);
    const edited = text.replace(sentence(40), "Sentence number 40 was amended by the clinician.");
    const c = chunkText(edited);
    expect(c.length).toBe(a.length);
    expect(c[0]!.hash).toBe(a[0]!.hash);
    expect(c[c.length - 1]!.hash).not.toBe(a[a.length - 1]!.hash);
  });

  it("hard-cuts an unbroken run of characters at the size limit", () => {
    const text = "x".repeat(2000);
    const chunks = chunkText(text, { size: 800, overlap: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(800);
    expect(chunks[0]!.content.length).toBe(800);
  });

  it("clamps the overlap to half the chunk size so progress is always made", () => {
    const text = paragraphs(6, 4);
    const chunks = chunkText(text, { size: 200, overlap: 5000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(200);
  });
});
