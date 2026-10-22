import { test, expect } from "@playwright/test";
test("the dashboard works on a phone: drawer navigation and no horizontal overflow", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /open navigation/i }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Patients" }).click();
  await expect(page).toHaveURL(/\/dashboard\/patients/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "e2e/artifacts/mobile-patients.png", fullPage: true });
});
