/**
 * Typed fetch for client components. Sends JSON, parses JSON, and throws an
 * `ApiError` carrying the server's `error` code and status so forms can show
 * precise messages (validation issues, 404 not_found, 409 conflicts, 429…).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "request_failed";
    const message =
      body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : describe(res.status, code);
    throw new ApiError(res.status, code, body, message);
  }
  return body as T;
}

function describe(status: number, code: string): string {
  switch (status) {
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "You do not have permission to do that.";
    case 404:
      return "Not found.";
    case 409:
      return code === "conflict" ? "That conflicts with existing data." : code.replace(/_/g, " ");
    case 422:
      return "Please check the highlighted fields.";
    case 429:
      return "Too many requests. Please wait a moment.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Flattened Zod issues from a 422 response, keyed by field. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const issues = (err.body as { issues?: { fieldErrors?: Record<string, string[]> } })?.issues?.fieldErrors ?? {};
  return Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v?.[0] ?? "Invalid"]));
}
