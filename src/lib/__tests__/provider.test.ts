import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    AI_DEFAULT_PROVIDER: "auto",
    AI_EMBEDDING_PROVIDER: "auto",
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    OPENAI_MODEL: "gpt-test",
    OPENAI_EMBEDDING_MODEL: "text-embedding-test",
    ANTHROPIC_MODEL: "claude-test",
    GEMINI_MODEL: "gemini-test",
    GEMINI_EMBEDDING_MODEL: "gemini-embedding-test",
    AI_TIMEOUT_MS: 5000,
  },
}));

import { env } from "@/lib/env";
import { aiStatus, chatProvider, embeddingProvider } from "@/lib/ai/provider";
import { AiProviderError, EMBEDDING_DIMENSIONS } from "@/lib/ai/types";
import { GeminiProvider } from "@/lib/ai/gemini";
import { OpenAiProvider } from "@/lib/ai/openai";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { EchoProvider, hashEmbed, parseContextItems } from "@/lib/ai/echo";
import { normalizeVector, vectorNorm } from "@/lib/ai/vectors";

type Keys = { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; GEMINI_API_KEY?: string };

function configure(keys: Keys, routing: { chat?: typeof env.AI_DEFAULT_PROVIDER; embed?: typeof env.AI_EMBEDDING_PROVIDER } = {}) {
  env.OPENAI_API_KEY = keys.OPENAI_API_KEY;
  env.ANTHROPIC_API_KEY = keys.ANTHROPIC_API_KEY;
  env.GEMINI_API_KEY = keys.GEMINI_API_KEY;
  env.AI_DEFAULT_PROVIDER = routing.chat ?? "auto";
  env.AI_EMBEDDING_PROVIDER = routing.embed ?? "auto";
}

beforeEach(() => configure({}));

describe("provider routing", () => {
  it("falls back to the offline echo provider when nothing is configured", () => {
    expect(chatProvider().name).toBe("echo");
    expect(embeddingProvider().name).toBe("echo");
    expect(aiStatus()).toEqual({
      chat: { provider: "echo", model: "echo-1", configured: false },
      embeddings: { provider: "echo", model: "echo-embed-1", configured: false },
    });
  });

  it("auto prefers gemini, then openai, then anthropic for chat", () => {
    configure({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" });
    expect(chatProvider().name).toBe("gemini");
    configure({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" });
    expect(chatProvider().name).toBe("openai");
    configure({ ANTHROPIC_API_KEY: "a" });
    expect(chatProvider().name).toBe("anthropic");
  });

  it("auto prefers gemini then openai for embeddings and never anthropic", () => {
    configure({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" });
    expect(embeddingProvider().name).toBe("gemini");
    configure({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" });
    expect(embeddingProvider().name).toBe("openai");
    configure({ ANTHROPIC_API_KEY: "a" });
    expect(embeddingProvider().name).toBe("echo");
  });

  it("honours an explicit provider when it is configured", () => {
    configure({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }, { chat: "anthropic", embed: "openai" });
    expect(chatProvider().name).toBe("anthropic");
    expect(embeddingProvider().name).toBe("openai");
    expect(chatProvider("openai").name).toBe("openai");
  });

  it("falls back to the auto order, never silently to echo, when the explicit provider has no key", () => {
    configure({ GEMINI_API_KEY: "g" }, { chat: "openai", embed: "openai" });
    expect(chatProvider().name).toBe("gemini");
    expect(embeddingProvider().name).toBe("gemini");
    configure({ ANTHROPIC_API_KEY: "a" }, { chat: "openai" });
    expect(chatProvider().name).toBe("anthropic");
    configure({ OPENAI_API_KEY: "o" }, { chat: "anthropic" });
    expect(chatProvider("gemini").name).toBe("openai");
  });

  it("honours an explicit echo even when real keys exist", () => {
    configure({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }, { chat: "echo", embed: "echo" });
    expect(chatProvider().name).toBe("echo");
    expect(embeddingProvider().name).toBe("echo");
  });

  it("reports the configured models in the status snapshot", () => {
    configure({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }, { chat: "anthropic" });
    expect(aiStatus()).toEqual({
      chat: { provider: "anthropic", model: "claude-test", configured: true },
      embeddings: { provider: "gemini", model: "gemini-embedding-test", configured: true },
    });
  });
});

describe("vectors", () => {
  it("L2-normalises to unit length and leaves a zero vector alone", () => {
    const v = normalizeVector([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect(vectorNorm(v)).toBeCloseTo(1);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });

  it("the echo hash embedding is deterministic, 1536-dim and unit length", () => {
    const a = hashEmbed("Essential hypertension", EMBEDDING_DIMENSIONS);
    const b = hashEmbed("Essential hypertension", EMBEDDING_DIMENSIONS);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vectorNorm(a)).toBeCloseTo(1);
    expect(hashEmbed("Something else entirely", EMBEDDING_DIMENSIONS)).not.toEqual(a);
  });
});

describe("adapters over fetch", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function lastRequest() {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("gemini embeds with the key in a header, 1536 dims, a task type, a timeout, and normalises the result", async () => {
    configure({ GEMINI_API_KEY: "secret-key" });
    const raw = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [{ values: raw }, { values: raw }] }));

    const result = await new GeminiProvider().embed(["doc one", "doc two"], { kind: "document" });
    expect(result).toMatchObject({ provider: "gemini", model: "gemini-embedding-test" });
    expect(result.vectors).toHaveLength(2);
    expect(vectorNorm(result.vectors[0]!)).toBeCloseTo(1);
    expect(result.vectors[0]![0]).toBeCloseTo(0.6);

    const { url, init, body } = lastRequest();
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-test:batchEmbedContents");
    expect(url).not.toContain("secret-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const requests = body.requests as { taskType: string; outputDimensionality: number; model: string }[];
    expect(requests[0]).toMatchObject({
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EMBEDDING_DIMENSIONS,
      model: "models/gemini-embedding-test",
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ embeddings: [{ values: raw }] }));
    await new GeminiProvider().embed(["a query"], { kind: "query" });
    expect((lastRequest().body.requests as { taskType: string }[])[0]!.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("gemini chats with the configured model, system instruction and key header", async () => {
    configure({ GEMINI_API_KEY: "secret-key" });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ candidates: [{ content: { parts: [{ text: "Grounded answer [1]" }] }, finishReason: "STOP" }] }),
    );
    const result = await new GeminiProvider().chat([
      { role: "system", content: "rules" },
      { role: "user", content: "question" },
    ]);
    expect(result).toMatchObject({ provider: "gemini", model: "gemini-test", content: "Grounded answer [1]", finishReason: "stop" });
    const { url, body } = lastRequest();
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(body.systemInstruction).toEqual({ parts: [{ text: "rules" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "question" }] }]);
  });

  it("maps a non-2xx answer to a typed AiProviderError without leaking the request", async () => {
    configure({ GEMINI_API_KEY: "secret-key" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Resource exhausted" } }, 429));
    const err = await new GeminiProvider().chat([{ role: "user", content: "very private prompt" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    const typed = err as AiProviderError;
    expect(typed.provider).toBe("gemini");
    expect(typed.status).toBe(429);
    expect(typed.message).toContain("Resource exhausted");
    expect(typed.message).not.toContain("very private prompt");
  });

  it("maps a timeout to AiProviderError with status 0", async () => {
    configure({ OPENAI_API_KEY: "sk" });
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const err = await new OpenAiProvider().chat([{ role: "user", content: "q" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).status).toBe(0);
    expect((err as AiProviderError).message).toContain("timed out");
  });

  it("openai chats on OPENAI_MODEL and embeds on OPENAI_EMBEDDING_MODEL at 1536 dims", async () => {
    configure({ OPENAI_API_KEY: "sk" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "length" }] }));
    const chat = await new OpenAiProvider().chat([{ role: "user", content: "q" }], { jsonMode: true });
    expect(chat).toMatchObject({ provider: "openai", model: "gpt-test", content: "ok", finishReason: "length" });
    let req = lastRequest();
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((req.init.headers as Record<string, string>).Authorization).toBe("Bearer sk");
    expect(req.body).toMatchObject({ model: "gpt-test", response_format: { type: "json_object" } });

    const unit = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ embedding: unit, index: 1 }, { embedding: unit, index: 0 }] }));
    const embed = await new OpenAiProvider().embed(["a", "b"]);
    expect(embed.model).toBe("text-embedding-test");
    expect(embed.vectors).toHaveLength(2);
    req = lastRequest();
    expect(req.body).toMatchObject({ model: "text-embedding-test", input: ["a", "b"], dimensions: EMBEDDING_DIMENSIONS });

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Incorrect API key" } }, 401));
    const err = await new OpenAiProvider().embed(["a"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).status).toBe(401);
  });

  it("anthropic chats on ANTHROPIC_MODEL through the Messages API and has no embeddings", async () => {
    configure({ ANTHROPIC_API_KEY: "ak" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: "text", text: "claude says" }], stop_reason: "end_turn" }));
    const result = await new AnthropicProvider().chat([
      { role: "system", content: "rules" },
      { role: "user", content: "q" },
    ]);
    expect(result).toMatchObject({ provider: "anthropic", model: "claude-test", content: "claude says", finishReason: "stop" });
    const { url, init, body } = lastRequest();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("ak");
    expect(body).toMatchObject({ model: "claude-test", system: "rules", messages: [{ role: "user", content: "q" }] });

    const err = await new AnthropicProvider().embed().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(new AnthropicProvider().supportsEmbeddings()).toBe(false);
  });
});

describe("echo provider", () => {
  const system = [
    "Answer only from the context.",
    "",
    "CONTEXT:",
    "[1] DIAGNOSIS · Profile & medical history · patient: Ahmed Mahmoud",
    "Patient: Ahmed Mahmoud (56-year-old male), preferred language: Arabic.",
    "Diagnoses: Essential hypertension.",
    "Allergies: Penicillin.",
    "",
    "[2] MEDICATION · Medications · patient: Ahmed Mahmoud",
    "Active medications:",
    "- Amlodipine 5 mg once daily",
  ].join("\n");

  it("parses context items with their markers", () => {
    const items = parseContextItems(system);
    expect(items.map((i) => i.index)).toEqual([1, 2]);
    expect(items[0]!.heading).toContain("Ahmed Mahmoud");
    expect(items[0]!.lines).toContain("Diagnoses: Essential hypertension.");
    expect(items[1]!.lines).toEqual(["Active medications:", "- Amlodipine 5 mg once daily"]);
    expect(parseContextItems("CONTEXT:\n(none)")).toEqual([]);
    expect(parseContextItems("no context block at all")).toEqual([]);
  });

  it("writes a grounded summary quoting the most relevant facts with citation markers", async () => {
    const result = await new EchoProvider().chat([
      { role: "system", content: system },
      { role: "user", content: "What medication is Ahmed Mahmoud taking for hypertension?" },
    ]);
    expect(result.provider).toBe("echo");
    expect(result.content).toContain("[1]");
    expect(result.content).toContain("[2]");
    expect(result.content).toContain("Amlodipine 5 mg once daily");
    expect(result.content).toContain("Essential hypertension");
    expect(result.content).toMatch(/offline mode/i);
  });

  it("says plainly when no records were retrieved", async () => {
    const result = await new EchoProvider().chat([
      { role: "system", content: "rules\n\nCONTEXT:\n(none)" },
      { role: "user", content: "Who has asthma?" },
    ]);
    expect(result.content).toMatch(/no matching records/i);
    expect(result.content).not.toMatch(/\[\d+\]/);
  });
});
