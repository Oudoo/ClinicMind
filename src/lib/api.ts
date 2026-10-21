import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { RbacError } from "@/lib/auth/rbac";
import { TenantNotFoundError } from "@/lib/tenant";

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
  console.error("[api] unhandled error", err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
