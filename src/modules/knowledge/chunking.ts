import { createHash } from "node:crypto";

/**
 * Text chunking for the RAG store.
 *
 * Documents are split into ~800-character chunks with ~100 characters of
 * overlap so a fact that straddles a boundary is still retrievable from one
 * chunk. Cuts prefer paragraph breaks, then line breaks, then sentence ends,
 * then whitespace, and only fall back to a hard cut for a single unbroken run
 * of characters. The output is deterministic: identical input always produces
 * identical chunks and hashes, which is what makes re-indexing idempotent.
 */
export interface TextChunk {
  /** 0-based position within the document. */
  index: number;
  content: string;
  /** SHA-256 (hex) of `content`. */
  hash: string;
}

export interface ChunkOptions {
  /** Target maximum chunk length in characters. */
  size?: number;
  /** Characters of the previous chunk repeated at the start of the next one. */
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 100;

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Collapse whitespace noise without disturbing paragraph structure. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const size = Math.max(50, Math.floor(opts.size ?? DEFAULT_CHUNK_SIZE));
  const overlap = Math.min(Math.max(0, Math.floor(opts.overlap ?? DEFAULT_CHUNK_OVERLAP)), Math.floor(size / 2));
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const pieces: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      end = findBreak(normalized, start, end, size);
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= normalized.length) break;

    // Next chunk starts `overlap` characters back, snapped forward to a word
    // boundary so the overlap never begins mid-word; always makes progress.
    let next = Math.max(end - overlap, start + 1);
    const ws = normalized.slice(next, end).search(/\s/);
    if (ws > 0) next += ws + 1;
    start = Math.min(Math.max(next, start + 1), end);
  }

  return pieces.map((content, index) => ({ index, content, hash: contentHash(content) }));
}

/**
 * Find the best cut position in (start + size/2, end]. Preference order:
 * paragraph break, line break, sentence end, whitespace; otherwise `end`.
 */
function findBreak(text: string, start: number, end: number, size: number): number {
  const floor = start + Math.floor(size / 2);
  const window = text.slice(floor, end);

  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph !== -1) return floor + paragraph + 2;

  const line = window.lastIndexOf("\n");
  if (line !== -1) return floor + line + 1;

  let sentence = -1;
  for (const m of window.matchAll(/[.!?؟。](?=\s)/g)) sentence = m.index + 1;
  if (sentence !== -1) return floor + sentence;

  let space = -1;
  for (const m of window.matchAll(/\s/g)) space = m.index;
  if (space !== -1) return floor + space + 1;

  return end;
}
