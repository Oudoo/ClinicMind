import { test, expect, type Page } from "@playwright/test";
import { ANONYMOUS, DEMO_PASSWORD } from "./helpers";

/**
 * Every other demo account, and every page its menu offers: each opens with its heading, without
 * the error page, a script error or a server error. Read only, so it also runs against a live
 * demo (the Hostinger workflow does, after a deploy).
 */
const ACCOUNTS = ["doctor@demo.clinic", "nurse@demo.clinic", "reception@demo.clinic", "ai@demo.clinic", "platform@demo.clinic"];

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`script error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return errors;
}

test.use({ storageState: ANONYMOUS });

for (const email of ACCOUNTS) {
  test(`${email}: every page in the menu opens`, async ({ page }) => {
    const errors = watch(page);
    await page.goto("/login");
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/password/i).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|platform)/);
    const menu = page.getByRole("navigation", { name: "Main" });
    const pages = (await menu.count())
      ? await menu.getByRole("link").evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/")))])
      : [new URL(page.url()).pathname];
    expect(pages.length).toBeGreaterThan(0);
    for (const path of pages) {
      await page.goto(path);
      await expect.soft(page.getByRole("heading").first(), path).toBeVisible();
      await expect.soft(page.getByText("This page could not be shown"), path).toHaveCount(0, { timeout: 1_000 });
    }
    expect(errors).toEqual([]);
  });
}
