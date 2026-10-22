import { env } from "@/lib/env";
import { AiProviderError } from "./types";

/**
 * Shared transport for every provider adapter.
 *
 * - Every upstream call is bounded by `AI_TIMEOUT_MS` via `AbortSignal.timeout`.
 * - A non-2xx answer becomes a typed `AiProviderError { provider, status }`.
 * - Nothing is logged here: request bodies carry prompts and patient context.
 *   The error message quotes at most a short excerpt of the provider's own
 *   error text (never our request) so operators can tell a bad key from a bad
 *   model id.
 */
export async function aiFetchJson<T>(
  provider: string,
  url: string,
  init: { method?: "POST" | "GET"; headers?: Record<string, string>; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(env.AI_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new AiProviderError(
      provider,
      0,
      timedOut ? `${provider} request timed out after ${env.AI_TIMEOUT_MS}ms` : `${provider} request failed: ${describe(err)}`,
    );
  }

  if (!res.ok) {
    throw new AiProviderError(provider, res.status, `${provider} responded ${res.status}: ${await errorExcerpt(res)}`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new AiProviderError(provider, res.status, `${provider} returned a non-JSON response`);
  }
}

async function errorExcerpt(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const message = extractMessage(text) ?? text;
    return message.replace(/\s+/g, " ").trim().slice(0, 240) || res.statusText || "no details";
  } catch {
    return res.statusText || "no details";
  }
}

/** Most providers wrap errors as `{ error: { message } }` or `{ message }`. */
function extractMessage(text: string): string | null {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof json.error === "string") return json.error;
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") return json.error.message;
    if (typeof json.message === "string") return json.message;
  } catch {
    // not JSON
  }
  return null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
