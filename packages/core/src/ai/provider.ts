import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { db, costTracking, usageRecords } from "@growengine/db";
import { env } from "../env.js";

/**
 * AI provider abstraction. Primary provider is env-configured
 * (AI_PRIMARY_PROVIDER); the other acts as automatic failover. Every call
 * records token usage + USD cost into cost_tracking and usage_records so
 * the Cost Tracking Dashboard reflects reality per tenant/client/feature.
 */

export interface AiCallContext {
  tenantId: string;
  clientId?: string | null;
  projectId?: string | null;
  feature: string;
  aiJobId?: string | null;
}

export interface AiCompletionOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Force JSON output; the prompt must describe the schema. */
  json?: boolean;
}

/** USD per 1M tokens — keep current with provider pricing pages. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? { input: 3, output: 15 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

function anthropic(): Anthropic {
  if (!env.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  anthropicClient ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return anthropicClient;
}

export function openai(): OpenAI {
  if (!env.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
  openaiClient ??= new OpenAI({ apiKey: env.openaiApiKey });
  return openaiClient;
}

export async function recordAiCost(
  ctx: AiCallContext,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
) {
  const cost = costUsd(model, inputTokens, outputTokens);
  await db.insert(costTracking).values({
    tenantId: ctx.tenantId,
    clientId: ctx.clientId ?? null,
    projectId: ctx.projectId ?? null,
    provider,
    model,
    feature: ctx.feature,
    inputTokens,
    outputTokens,
    costUsd: cost.toFixed(6),
    aiJobId: ctx.aiJobId ?? null,
  });
  await db.insert(usageRecords).values({
    tenantId: ctx.tenantId,
    meter: "ai_tokens",
    quantity: String(inputTokens + outputTokens),
    usageDate: new Date().toISOString().slice(0, 10),
    metadata: { provider, model, feature: ctx.feature },
  });
  return cost;
}

async function completeWithAnthropic(
  prompt: string,
  opts: AiCompletionOptions,
  ctx: AiCallContext
): Promise<string> {
  const model = env.anthropicModel;
  const res = await anthropic().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.2,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });
  await recordAiCost(ctx, "anthropic", model, res.usage.input_tokens, res.usage.output_tokens);
  const block = res.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
}

async function completeWithOpenAi(
  prompt: string,
  opts: AiCompletionOptions,
  ctx: AiCallContext
): Promise<string> {
  const model = env.openaiModel;
  const res = await openai().chat.completions.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.2,
    response_format: opts.json ? { type: "json_object" } : undefined,
    messages: [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      { role: "user" as const, content: prompt },
    ],
  });
  await recordAiCost(
    ctx,
    "openai",
    model,
    res.usage?.prompt_tokens ?? 0,
    res.usage?.completion_tokens ?? 0
  );
  return res.choices[0]?.message?.content ?? "";
}

/**
 * Complete a prompt with the primary provider, falling back to the
 * secondary if the primary is unconfigured or errors.
 */
export async function aiComplete(
  prompt: string,
  ctx: AiCallContext,
  opts: AiCompletionOptions = {}
): Promise<string> {
  const order =
    env.aiPrimaryProvider === "openai"
      ? (["openai", "anthropic"] as const)
      : (["anthropic", "openai"] as const);

  let lastError: Error | null = null;
  for (const provider of order) {
    const hasKey = provider === "anthropic" ? !!env.anthropicApiKey : !!env.openaiApiKey;
    if (!hasKey) continue;
    try {
      return provider === "anthropic"
        ? await completeWithAnthropic(prompt, opts, ctx)
        : await completeWithOpenAi(prompt, opts, ctx);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error("No AI provider configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)");
}

/** Complete and parse a JSON response, stripping markdown fences if present. */
export async function aiCompleteJson<T>(
  prompt: string,
  ctx: AiCallContext,
  opts: AiCompletionOptions = {}
): Promise<T> {
  const raw = await aiComplete(prompt, ctx, { ...opts, json: true });
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf(cleaned.startsWith("[") ? "[" : "{");
  const jsonText = start >= 0 ? cleaned.slice(start) : cleaned;
  return JSON.parse(jsonText) as T;
}
