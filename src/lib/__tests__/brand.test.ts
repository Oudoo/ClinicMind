import { describe, it, expect } from "vitest";
import { hexToHslTriplet, tenantThemeStyle } from "@/lib/brand";

describe("brand theming", () => {
  it("converts the electric indigo hex to the expected HSL triplet", () => {
    expect(hexToHslTriplet("#4F46E5")).toBe("243 75% 59%");
  });

  it("returns null for invalid hex", () => {
    expect(hexToHslTriplet("not-a-color")).toBeNull();
  });

  it("produces accent override variables for a tenant", () => {
    const style = tenantThemeStyle({ accent: "#10B981" }) as Record<string, string>;
    expect(style["--accent"]).toBeTruthy();
    expect(style["--ring"]).toBe(style["--accent"]);
  });

  it("returns an empty style object when no branding is provided", () => {
    expect(tenantThemeStyle(null)).toEqual({});
  });
});
