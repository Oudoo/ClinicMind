import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function run(path: string, headers: Record<string, string> = {}) {
  return middleware(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

describe("middleware", () => {
  it("sends an uncredentialed dashboard visit to /login and remembers the path", () => {
    const res = run("/dashboard/patients?q=ahmed");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/dashboard/patients?q=ahmed");
  });

  it("passes a request that carries a session cookie through to the layout", () => {
    const res = run("/dashboard", { cookie: "cm_session=anything" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("never redirects API or public paths — those enforce auth themselves", () => {
    for (const path of ["/api/patients", "/api/me", "/login", "/", "/embed/demo"]) {
      expect(run(path).status).toBe(200);
    }
  });

  it("strips client-supplied tenant headers before they reach the app", () => {
    const res = run("/api/patients", { "x-clinicmind-tenant": "demo", "x-other": "keep" });
    const forwarded = res.headers.get("x-middleware-override-headers") ?? "";
    expect(forwarded).not.toContain("x-clinicmind-tenant");
    expect(forwarded).toContain("x-other");
    expect(res.headers.get("x-middleware-request-x-clinicmind-tenant")).toBeNull();
  });

  it("denies framing everywhere except the embed surface", () => {
    expect(run("/login").headers.get("x-frame-options")).toBe("DENY");
    expect(run("/dashboard").headers.get("x-frame-options")).toBe("DENY");
    expect(run("/embed/demo").headers.get("x-frame-options")).toBeNull();
  });
});
