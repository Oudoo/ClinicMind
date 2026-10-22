import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function run(path: string, headers: Record<string, string> = {}) {
  return proxy(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

vi.mock("@/lib/embed-origins", () => ({
  getEmbedOrigins: vi.fn(async (slug: string) =>
    slug === "demo" ? { enabled: true, origins: ["https://care.example.com"] } : null,
  ),
}));

describe("proxy", () => {
  it("sends an uncredentialed dashboard visit to /login and remembers the path", async () => {
    const res = await run("/dashboard/patients?q=ahmed");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/dashboard/patients?q=ahmed");
  });

  it("passes a request that carries a session cookie through to the layout", async () => {
    const res = await run("/dashboard", { cookie: "cm_session=anything" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("never redirects API or public paths — those enforce auth themselves", async () => {
    for (const path of ["/api/patients", "/api/me", "/login", "/", "/embed/demo"]) {
      expect((await run(path)).status).toBe(200);
    }
  });

  it("strips client-supplied tenant headers before they reach the app", async () => {
    const res = await run("/api/patients", { "x-clinicmind-tenant": "demo", "x-other": "keep" });
    const forwarded = res.headers.get("x-middleware-override-headers") ?? "";
    expect(forwarded).not.toContain("x-clinicmind-tenant");
    expect(forwarded).toContain("x-other");
    expect(res.headers.get("x-middleware-request-x-clinicmind-tenant")).toBeNull();
  });

  it("denies framing everywhere except the embed surface", async () => {
    expect((await run("/login")).headers.get("x-frame-options")).toBe("DENY");
    expect((await run("/login")).headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await run("/dashboard")).headers.get("x-frame-options")).toBe("DENY");
    expect((await run("/embed/demo")).headers.get("x-frame-options")).toBeNull();
    expect((await run("/embed/demo")).headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://care.example.com",
    );
    expect((await run("/embed/unknown")).headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});

describe("proxy rate limiting", () => {
  it("throttles the AI endpoints per client address", async () => {
    let last = 200;
    for (let i = 0; i < 45; i++) {
      last = (await run("/api/assistant", { "x-forwarded-for": "203.0.113.9" })).status;
    }
    expect(last).toBe(429);
    // Other clients are unaffected.
    expect((await run("/api/assistant", { "x-forwarded-for": "203.0.113.10" })).status).toBe(200);
  });
});
