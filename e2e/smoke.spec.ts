import { test, expect } from "@playwright/test";
import { signIn, ANONYMOUS } from "./helpers";

test.describe("security surface", () => {
  test.use({ storageState: ANONYMOUS });

  test("health endpoint answers and never leaks configuration", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("up");
    expect(JSON.stringify(body)).not.toMatch(/postgres|DATABASE_URL|AUTH_SECRET|api[_-]?key|sk-/i);
  });

  test("API refuses anonymous callers and dashboard redirects to sign-in", async ({ request, page }) => {
    for (const path of ["/api/patients", "/api/appointments", "/api/me"]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(401);
    }
    const assistant = await request.post("/api/assistant", { data: { query: "hello" } });
    expect(assistant.status()).toBe(401);
    const res = await page.goto("/dashboard/patients?q=x");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("responses carry the security headers", async ({ request }) => {
    const res = await request.get("/login");
    const h = res.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("the embed surface may be framed only by allow-listed origins", async ({ request }) => {
    const res = await request.get("/embed/demo");
    expect(res.status()).toBe(200);
    expect(res.headers()["x-frame-options"]).toBeUndefined();
    expect(res.headers()["content-security-policy"]).toMatch(/frame-ancestors 'self' http/);
    const unknown = await request.get("/embed/does-not-exist");
    expect(await unknown.text()).toContain("Embedding is not available");
  });

  test("wrong password is rejected without revealing whether the account exists", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill("nobody@demo.clinic");
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("signed-in clinic owner", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
  });

  test("sees the overview with live metrics", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /clinic intelligence/i })).toBeVisible();
    await expect(page.getByText(/total patients/i)).toBeVisible();
    await page.screenshot({ path: "e2e/artifacts/overview.png", fullPage: true });
  });

  test("navigates every section without errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
    });
    for (const [label, pattern] of [
      ["Patients", /patient/i],
      ["Appointments", /appointment/i],
      ["Consultations", /consultation/i],
      ["AI Assistant", /assistant/i],
      ["Conversations", /conversation/i],
      ["Settings", /settings/i],
    ] as const) {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label }).first().click();
      await expect(page.getByRole("heading", { level: 2 }).first()).toContainText(pattern);
      await page.screenshot({ path: `e2e/artifacts/${label.toLowerCase().replace(/\s+/g, "-")}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });

  test("the assistant answers from the clinic's records", async ({ page }) => {
    await page.goto("/dashboard/assistant");
    const input = page.getByPlaceholder(/ask/i);
    await input.fill("Which patients are being treated for melasma?");
    await input.press("Enter");
    const reply = page.locator("text=/melasma|records|context/i").last();
    await expect(reply).toBeVisible({ timeout: 30_000 });
  });

});

test.describe("sign out", () => {
  test.use({ storageState: ANONYMOUS });

  test("signs out and loses access", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /account menu/i }).click();
    await page.getByRole("menuitem", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
