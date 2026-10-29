import type { AiMessage, AiProvider } from "@/lib/ai/types";
import { MAX_CITED_PASSAGES, NO_GOOD_SOURCE, NO_GOOD_SOURCE_AR } from "./constants";
import { sentences } from "./passages";
import { analyzeQuestion, rank, speaksOf, tokenize, type Scored } from "./search";

/**
 * The evidence panel's answer: only from the clinic's approved passages, and
 * every statement linked to the passage it comes from.
 *
 * Which passages may answer: those speaking of at least half of what the
 * question asks about (all of it, for a question of one or two things; a drug
 * counts once, by any of its names), of a drug it names when it names one
 * (otherwise of the condition or procedure it names), and scoring within reach
 * of the best. The source's
 * title counts as part of each of its passages. None: "no good source",
 * plainly.
 *
 * With a language model, it answers from those passages alone and each of
 * its sentences must carry the marker of a passage it was given; a sentence
 * without one is dropped, and nothing left means no good source. Without one
 * (the offline demo), the statements are the passages' own sentences that
 * answer the question best, quoted.
 */

export interface CandidatePassage {
  id: string;
  sourceId: string;
  /** The source's title: "Isotretinoin: the clinic's protocol" makes each of its passages about isotretinoin. */
  title?: string;
  heading: string | null;
  content: string;
}

export interface Statement {
  text: string;
  /** 1-based numbers of the cited passages (the order of `cited`). */
  cites: number[];
}

export interface EvidenceAnswer {
  grounded: boolean;
  statements: Statement[];
  /** The passages the statements cite, numbered from 1. */
  cited: Scored<CandidatePassage>[];
  /** "library" (the passages' own sentences) or the model that wrote it. */
  mode: "library" | "model";
  provider: string;
  model: string;
  /** What was sent to the model (no names or IDs), for the log. */
  prompt: string | null;
}

const RELATIVE_FLOOR = 0.35;

export function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

export function noGoodSource(question: string): string {
  return isArabic(question) ? NO_GOOD_SOURCE_AR : NO_GOOD_SOURCE;
}

/** The passages that may answer the question, best first, numbered in that order. */
export function answerablePassages(question: string, passages: CandidatePassage[]): Scored<CandidatePassage>[] {
  const { terms, units } = analyzeQuestion(question);
  if (!units.length) return [];
  const ranked = rank(
    passages.map((p) => ({ ...p, text: `${p.title ?? ""}\n${p.heading ?? ""}\n${p.content}` })),
    terms,
  );
  const need = units.length <= 2 ? units.length : Math.ceil(units.length / 2);
  // A question naming a drug is about that drug: "spironolactone for acne" is not answered by the isotretinoin protocol.
  const drugs = units.filter((u) => u.kind === "drug");
  const named = drugs.length ? drugs : units.filter((u) => u.concept);
  const kept = ranked.filter((r) => units.filter((u) => speaksOf(u, r.matched)).length >= need && (!named.length || named.some((u) => speaksOf(u, r.matched))));
  const top = kept[0]?.score ?? 0;
  return kept
    .filter((r) => r.score >= top * RELATIVE_FLOOR)
    .slice(0, MAX_CITED_PASSAGES)
    .map((r) => ({ ...r, item: { id: r.item.id, sourceId: r.item.sourceId, title: r.item.title, heading: r.item.heading, content: r.item.content } }));
}

/** The passages' own sentences that answer best: one or two per passage, in the passage's order. */
export function quoteAnswer(question: string, cited: Scored<CandidatePassage>[]): Statement[] {
  const { terms } = analyzeQuestion(question);
  const want = new Set(terms);
  const out: Statement[] = [];
  cited.forEach((c, i) => {
    const scored = sentences(c.item.content).map((text, at) => {
      const words = new Set(tokenize(text));
      return { text, at, hits: [...want].filter((t) => words.has(t)).length };
    });
    const best = scored
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.at - b.at)
      .slice(0, 2)
      .sort((a, b) => a.at - b.at);
    for (const s of best) out.push({ text: s.text, cites: [i + 1] });
  });
  return out;
}

const MARKER = /\[(\d+)\]/g;

/** A model's reply as statements: only sentences carrying the marker of a passage it was given. */
export function statementsFromReply(reply: string, passages: number): Statement[] | null {
  if (/NO_GOOD_SOURCE/.test(reply)) return null;
  const out: Statement[] = [];
  for (const sentence of reply.replace(/\s+/g, " ").match(/[^.!?؟]+(?:[.!?؟]+|$)(?:\s*(?:\[\d+\])+)?/g) ?? []) {
    const cites = [...new Set([...sentence.matchAll(MARKER)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= passages);
    const text = sentence.replace(MARKER, "").replace(/\s+([.,;:!?؟])/g, "$1").trim();
    if (cites.length && text.length > 1) out.push({ text, cites });
  }
  return out.length ? out : null;
}

export function systemPrompt(cited: Scored<CandidatePassage>[], titles: Map<string, string>, context: string[], arabic: boolean): string {
  const block = cited.map((c, i) => `[${i + 1}] ${titles.get(c.item.sourceId) ?? "Source"}${c.item.heading ? ` · ${c.item.heading}` : ""}\n${c.item.content}`).join("\n\n");
  return [
    "You answer a doctor's clinical question using ONLY the numbered passages below, from the clinic's approved library.",
    "End every sentence with the marker of the passage it comes from, like [1] or [1][3]. Never use knowledge from outside the passages.",
    "If the passages do not answer the question, reply exactly: NO_GOOD_SOURCE",
    `Answer in ${arabic ? "Arabic" : "English"}, in at most six short sentences.`,
    context.length ? `The patient (no name or ID is given): ${context.join("; ")}.` : "No patient is attached to the question.",
    "",
    "Passages:",
    block,
  ].join("\n");
}

export async function answerQuestion(
  question: string,
  passages: CandidatePassage[],
  opts: { provider: AiProvider; titles: Map<string, string>; context: string[] },
): Promise<EvidenceAnswer> {
  const cited = answerablePassages(question, passages);
  const none = (mode: EvidenceAnswer["mode"], provider: string, model: string, prompt: string | null): EvidenceAnswer => ({
    grounded: false,
    statements: [],
    cited: [],
    mode,
    provider,
    model,
    prompt,
  });
  if (!cited.length) return none("library", "clinicmind", "library-search", null);

  if (opts.provider.name === "echo") return libraryAnswer(question, cited);

  const system = systemPrompt(cited, opts.titles, opts.context, isArabic(question));
  const messages: AiMessage[] = [
    { role: "system", content: system },
    { role: "user", content: question },
  ];
  const result = await opts.provider.chat(messages, { temperature: 0, maxTokens: 600 });
  const statements = statementsFromReply(result.content, cited.length);
  const prompt = `${system}\n\nQuestion: ${question}`;
  if (!statements) return none("model", result.provider, result.model, prompt);
  return { grounded: true, ...onlyCited(statements, cited), mode: "model", provider: result.provider, model: result.model, prompt };
}

/** The passages' own sentences that answer the question: the answer without a model (offline, or when it fails). */
export function libraryAnswer(question: string, cited: Scored<CandidatePassage>[]): EvidenceAnswer {
  const statements = quoteAnswer(question, cited);
  if (!statements.length) return { grounded: false, statements: [], cited: [], mode: "library", provider: "clinicmind", model: "library-search", prompt: null };
  return { grounded: true, ...onlyCited(statements, cited), mode: "library", provider: "clinicmind", model: "library-quotes", prompt: null };
}

/** Only the passages a statement cites stay, numbered again in the order first cited. */
function onlyCited(statements: Statement[], cited: Scored<CandidatePassage>[]): Pick<EvidenceAnswer, "statements" | "cited"> {
  const used = [...new Set(statements.flatMap((s) => s.cites))];
  const renumber = new Map(used.map((n, i) => [n, i + 1]));
  return {
    statements: statements.map((s) => ({ text: s.text, cites: s.cites.map((n) => renumber.get(n)!) })),
    cited: used.map((n) => cited[n - 1]!),
  };
}
