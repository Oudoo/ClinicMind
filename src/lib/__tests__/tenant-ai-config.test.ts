import { describe, expect, it } from "vitest";
import { aiConfigOf, decryptSecret, encryptSecret, mergeAiConfig, overridesFrom, publicAiConfig } from "@/lib/ai/tenant-config";

describe("tenant AI configuration", () => {
  it("encrypts and decrypts a key; ciphertexts differ per call", () => {
    const a = encryptSecret("sk-test-1234");
    const b = encryptSecret("sk-test-1234");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptSecret(a)).toBe("sk-test-1234");
    expect(() => decryptSecret("v1.bad.bad.bad")).toThrow();
  });

  it("merges a patch: overrides, clears with inherit/empty, keeps undefined", () => {
    const current = mergeAiConfig({}, { chatProvider: "openai", keys: { openai: "sk-openai-abcd" }, models: { openaiChat: "gpt-4.1" } });
    expect(current.chatProvider).toBe("openai");
    expect(current.keys?.openai?.hint).toBe("abcd");
    expect(current.keys?.openai?.enc).not.toContain("sk-openai");
    expect(current.models?.openaiChat).toBe("gpt-4.1");

    const kept = mergeAiConfig(current, { transcriptionProvider: "gemini" });
    expect(kept.chatProvider).toBe("openai");
    expect(kept.keys?.openai?.hint).toBe("abcd");
    expect(kept.transcriptionProvider).toBe("gemini");

    const cleared = mergeAiConfig(kept, { chatProvider: "inherit", keys: { openai: "" }, models: { openaiChat: "" } });
    expect(cleared.chatProvider).toBeUndefined();
    expect(cleared.keys).toBeUndefined();
    expect(cleared.models).toBeUndefined();
    expect(cleared.transcriptionProvider).toBe("gemini");
  });

  it("exposes only set/unset and a four-character hint", () => {
    const cfg = mergeAiConfig({}, { keys: { gemini: "AIza-secret-9f3k" } });
    const pub = publicAiConfig(cfg);
    expect(pub.keys.gemini).toEqual({ set: true, hint: "…9f3k" });
    expect(pub.keys.openai).toEqual({ set: false, hint: null });
    expect(pub.chatProvider).toBe("inherit");
    expect(JSON.stringify(pub)).not.toContain("secret");
  });

  it("produces decrypted overrides for the registry and tolerates garbage", () => {
    const cfg = mergeAiConfig({}, { chatProvider: "anthropic", transcriptionProvider: "openai", keys: { anthropic: "sk-ant-xyz1", openai: "sk-o-2222" }, models: { anthropicChat: "claude-x", openaiTranscription: "gpt-4o-transcribe" } });
    const o = overridesFrom(cfg);
    expect(o?.chatProvider).toBe("anthropic");
    expect(o?.transcriptionProvider).toBe("openai");
    expect(o?.config?.anthropic).toEqual({ apiKey: "sk-ant-xyz1", chatModel: "claude-x" });
    expect(o?.config?.openai).toEqual({ apiKey: "sk-o-2222", transcriptionModel: "gpt-4o-transcribe" });
    expect(overridesFrom({})).toBeUndefined();
    expect(aiConfigOf(null)).toEqual({});
    expect(aiConfigOf({ ai: { chatProvider: "nonsense", keys: { gemini: "plain-string" }, models: { geminiChat: 42 } } })).toEqual({});
    // A key encrypted under another secret is treated as unset rather than failing the call.
    expect(overridesFrom({ keys: { gemini: { enc: "v1.AAAA.BBBB.CCCC", hint: "CCCC" } } })).toBeUndefined();
  });
});
