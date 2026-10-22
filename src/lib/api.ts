import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RbacError } from "@/lib/auth/rbac";
import { TenantNotFoundError } from "@/lib/tenant";
import { TenantScopeError } from "@/lib/tenant-scope";

/** Uniform JSON error mapping for route handlers. */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "validation_error", issues: err.flatten() }, { status: 422 });
  }
  if (err instanceof RbacError) {
    return NextResponse.json({ error: "forbidden", message: err.message }, { status: 403 });
  }
  if (err instanceof TenantNotFoundError) {
    return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
  }
  if (err instanceof TenantScopeError) {
    // A foreign-tenant id looks exactly like a missing one — never confirm it exists.
    return NextResponse.json({ error: "not_found", entity: err.entity }, { status: 404 });
  }
  console.error("[api] unhandled error", err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** 404 for an id that is missing — or belongs to another tenant, which must look identical. */
export function notFound(entity?: string) {
  return NextResponse.json(entity ? { error: "not_found", entity } : { error: "not_found" }, { status: 404 });
}

/** 429 with a `Retry-After` header; `error` distinguishes IP throttling from an account lockout. */
export function tooManyRequests(retryAfterSeconds: number, error = "rate_limited") {
  return NextResponse.json(
    { error, retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
