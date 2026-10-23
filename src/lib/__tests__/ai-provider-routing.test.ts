import { describe, expect, it } from "vitest";
import { chatProvider, transcriptionProvider, aiStatus } from "@/lib/ai/provider";

/**
 * Routing decisions are pure functions of the environment and the overrides.
 * The test environment has no vendor keys and AI_DEFAULT_PROVIDER=echo.
 */
describe("AI provider routing", () => {
  it("never falls back to echo for speech-to-text", () => {
    expect(transcriptionProvider()).toBeNull();
    expect(transcriptionProvider("gemini")).toBeNull();
    expect(aiStatus().transcription).toEqual({ provider: "none", model: "", configured: false });
  });

  it("uses echo for speech-to-text only when it is named", () => {
    const p = transcriptionProvider("echo");
    expect(p?.name).toBe("echo");
  });

  it("honours a tenant's own key and provider choice", () => {
    const stt = transcriptionProvider(undefined, { transcriptionProvider: "openai", config: { openai: { apiKey: "sk-tenant", transcriptionModel: "gpt-4o-mini-transcribe" } } });
    expect(stt?.name).toBe("openai");
    expect(stt?.transcriptionModel()).toBe("gpt-4o-mini-transcribe");

    const chat = chatProvider(undefined, { chatProvider: "anthropic", config: { anthropic: { apiKey: "sk-ant-tenant", chatModel: "claude-sonnet-5-5" } } });
    expect(chat.name).toBe("anthropic");
    expect(chat.chatModel()).toBe("claude-sonnet-5-5");

    // A tenant key for a provider that cannot transcribe does not make it a transcriber.
    expect(transcriptionProvider(undefined, { config: { anthropic: { apiKey: "sk-ant-tenant" } } })).toBeNull();
  });

  it("falls back to the auto order when the named provider has no key", () => {
    const chat = chatProvider(undefined, { chatProvider: "openai", config: { gemini: { apiKey: "AIza-tenant" } } });
    expect(chat.name).toBe("gemini");
    expect(chatProvider().name).toBe("echo");
  });
});
