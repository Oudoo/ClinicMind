import { describe, expect, it } from "vitest";
import {
  clientIp,
  isSameOrigin,
  normalizeEmail,
  readCookie,
  safeRedirectPath,
} from "@/lib/auth/request";

function req(headers: Record<string, string>, url = "http://localhost:3000/api/x"): Request {
  return new Request(url, { headers });
}

describe("readCookie", () => {
  it("finds a cookie among several and decodes it", () => {
    const r = req({ cookie: "a=1; cm_session=abc%3D%3D; b=2" });
    expect(readCookie(r, "cm_session")).toBe("abc==");
    expect(readCookie(r, "a")).toBe("1");
    expect(readCookie(r, "missing")).toBeUndefined();
    expect(readCookie(req({}), "a")).toBeUndefined();
  });
});

describe("clientIp", () => {
  it("prefers the first X-Forwarded-For hop, then X-Real-IP", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({}))).toBeNull();
  });
});

describe("isSameOrigin", () => {
  it("accepts requests without an Origin header", () => {
    expect(isSameOrigin(req({ host: "localhost:3000" }))).toBe(true);
  });
  it("accepts a matching Origin, including via X-Forwarded-Host", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
    expect(
      isSameOrigin(req({ host: "web:3000", "x-forwarded-host": "clinic.example.com", origin: "https://clinic.example.com" })),
    ).toBe(true);
  });
  it("rejects a foreign, opaque or malformed Origin", () => {
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "null" }))).toBe(false);
    expect(isSameOrigin(req({ host: "localhost:3000", origin: "not a url" }))).toBe(false);
  });
});

describe("safeRedirectPath", () => {
  it("only allows in-app paths", () => {
    expect(safeRedirectPath("/dashboard/patients?q=a")).toBe("/dashboard/patients?q=a");
    expect(safeRedirectPath("//evil.example/x")).toBeNull();
    expect(safeRedirectPath("/\\evil.example")).toBeNull();
    expect(safeRedirectPath("https://evil.example")).toBeNull();
    expect(safeRedirectPath("dashboard")).toBeNull();
    expect(safeRedirectPath("/x\r\nSet-Cookie: a=b")).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath("")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Owner@Demo.Clinic ")).toBe("owner@demo.clinic");
  });
});
